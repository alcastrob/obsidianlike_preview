import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ActiveMarkdownDocumentTracker } from "../activeMarkdownDocument";
import { log } from "../log";
import {
  buildNoteIndex,
  getAttachmentRoots,
  getImageMap,
  parseHeadings,
  resolveNoteUri,
  splitTarget,
} from "../noteUtils";

const OBSIDIANLIKE_EXTENSION_ID = "angelCastro.obsidian-like";
const TASKS_EXTENSION_ID = "angelCastro.obsidian-like-tasks";
/**
 * viewType del editor personalizado de `obsidianlike` (ver su `package.json` → `customEditors`,
 * `priority: "default"` para `*.md`). Es el render que este panel quiere para las notas `.md`
 * cuando el usuario pulsa un wikilink: se abren en el área de editores normal de VS Code, no aquí.
 */
const OBSIDIANLIKE_MARKDOWN_EDITOR_VIEW_TYPE = "vaultTool.markdownEditor";

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/**
 * Subconjunto de la API pública de `obsidianlike_tasks` que necesita este panel para
 * resolver bloques ```tasks```. Misma forma que `TasksExtensionApi` en
 * `../obsidianlike/src/extension.ts` (ver su CLAUDE.md, "Optional soft dependency") —
 * dependencia blanda: sin entrada en `extensionDependencies`, así que si la extensión
 * de tareas no está instalada los bloques ```tasks``` simplemente se quedan vacíos en
 * vez de romper el panel.
 */
interface TasksQueryResultDTO {
  items: unknown[];
  groups: Array<{ name: string; items: unknown[] }> | null;
  unrecognizedLines: string[];
}
interface TasksExtensionApi {
  renderTasksQuery?(queryText: string, queryFilePath?: string): TasksQueryResultDTO;
  toggleTaskAtLocation?(path: string, line: number): Promise<void>;
  editTaskAtLocation?(path: string, line: number): Promise<void>;
  onDidChangeTasks?: vscode.Event<void>;
}

let tasksApiPromise: Promise<TasksExtensionApi | undefined> | undefined;

/** Misma lógica "cachea el éxito, reintenta el fallo" que `getTasksApi()` en `../obsidianlike/src/extension.ts`. */
function getTasksApi(): Promise<TasksExtensionApi | undefined> {
  if (!tasksApiPromise) {
    tasksApiPromise = (async () => {
      const ext = vscode.extensions.getExtension(TASKS_EXTENSION_ID);
      if (!ext) {
        tasksApiPromise = undefined;
        return undefined;
      }
      try {
        return (await ext.activate()) as TasksExtensionApi;
      } catch {
        tasksApiPromise = undefined;
        return undefined;
      }
    })();
  }
  return tasksApiPromise;
}

/**
 * Interpreta el valor de `obsidianlikePreview.pinnedNote`, aceptando tanto una ruta absoluta
 * (Windows `C:\...`/`C:/...` o POSIX `/...`) como una ruta relativa a la raíz del workspace.
 * `path.isAbsolute` por sí solo no basta: en un host Windows si reconoce "C:\..." pero conviene
 * el respaldo por regex si algún día esto se ejecutara en otro SO con una ruta pegada de Windows.
 * Las rutas relativas se normalizan de "\" a "/" antes de `Uri.joinPath` — que, a diferencia de
 * `path.join`, solo entiende "/": una ruta con barras invertidas (como se escribe en Windows) se
 * trataría como un único segmento literal que no existe, y `openTextDocument` fallaría en silencio.
 */
function resolvePinnedNotePath(raw: string): vscode.Uri | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    return vscode.Uri.file(value);
  }
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!vaultRoot) {
    return undefined;
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  return vscode.Uri.joinPath(vaultRoot, normalized);
}

function naiveToggleTaskLine(lineText: string): string {
  if (/\[ \]/.test(lineText)) {
    return lineText.replace("[ ]", "[x]");
  }
  if (/\[[xX]\]/.test(lineText)) {
    return lineText.replace(/\[[xX]\]/, "[ ]");
  }
  return lineText;
}

/**
 * Panel lateral que muestra la nota Markdown activa renderizada con el mismo
 * bundle (`out/editor.bundle.js`) que usa la extensión hermana `obsidianlike`
 * para su propio editor personalizado — cargado directamente desde la
 * instalación de esa extensión (no se copia ni se reimplementa el renderer,
 * ver `extensionDependencies` en package.json). Como ese bundle es siempre
 * editable (no existe un modo solo-lectura en CodeMirror ahí), este panel es
 * en realidad una vista secundaria en vivo de la misma nota: editar aquí edita
 * el documento real, sincronizado en ambas direcciones con cualquier otro
 * editor que tenga la nota abierta.
 */
export class PanelViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private boundDocument: vscode.TextDocument | undefined;
  /** Último contenido que sabemos que coincide entre el documento real y el webview — evita aplicar ediciones no-op y distingue nuestros propios cambios de los externos. */
  private lastSyncedContent: string | undefined;
  private applyingOwnEdit = false;
  /** Se incrementa en cada `bindToActiveDocument()`; descarta resoluciones asíncronas obsoletas por un cambio de pestaña rápido. */
  private requestSeq = 0;
  private noteIndex: Array<{ name: string; dir: string }> = [];
  /** Uri de la nota fijada vía `obsidianlikePreview.pinnedNote`, o `undefined` si el panel debe seguir la pestaña activa. */
  private pinnedUri: vscode.Uri | undefined;
  private subscribedToTasksChanges = false;

  constructor(private readonly tracker: ActiveMarkdownDocumentTracker, context: vscode.ExtensionContext) {
    void this.refreshNoteIndex();
    this.refreshPinnedUri();
    void this.ensureSubscribedToTasksChanges();
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.md");
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => void this.refreshNoteIndex()),
      watcher.onDidDelete(() => void this.refreshNoteIndex()),
      vscode.workspace.onDidRenameFiles(() => void this.refreshNoteIndex()),
      tracker.onDidChange(() => void this.bindToActiveDocument()),
      vscode.workspace.onDidChangeTextDocument((e) => this.handleExternalChange(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("obsidianlikePreview.pinnedNote")) {
          this.refreshPinnedUri();
          void this.bindToActiveDocument();
        }
      })
    );
  }

  /** Lee `obsidianlikePreview.pinnedNote` y actualiza el estado + la clave de contexto usada por el botón "dejar de fijar". */
  private refreshPinnedUri(): void {
    const raw = vscode.workspace.getConfiguration("obsidianlikePreview").get<string>("pinnedNote", "").trim();
    this.pinnedUri = raw ? resolvePinnedNotePath(raw) : undefined;
    void vscode.commands.executeCommand("setContext", "obsidianlikePreview.pinned", !!this.pinnedUri);
  }

  /** Escribe la nota fijada en la configuración (workspace) — dispara `refreshPinnedUri()`/rebind vía `onDidChangeConfiguration`. */
  private async setPinnedNote(uri: vscode.Uri): Promise<void> {
    // `asRelativePath` devuelve separadores nativos del SO (barra invertida en Windows) — se
    // normalizan a "/" para que `resolvePinnedNotePath` (que solo entiende "/", igual que
    // `Uri.joinPath`) pueda releer el valor guardado sin importar en qué SO se escribió.
    const relPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    try {
      await vscode.workspace
        .getConfiguration("obsidianlikePreview")
        .update("pinnedNote", relPath, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      // `ConfigurationTarget.Workspace` falla si no hay una carpeta abierta como workspace —
      // antes este error se perdía en silencio (la promesa del comando simplemente rechazaba sin
      // que nada se lo mostrara al usuario) y el panel se quedaba sin fijar sin ninguna pista de
      // por qué.
      log(`setPinnedNote: ERROR al escribir "${relPath}" en obsidianlikePreview.pinnedNote: ${error}`);
      void vscode.window.showErrorMessage(
        `No se pudo guardar la nota fijada en la configuración: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Deja de fijar: vuelve a seguir la pestaña Markdown activa. */
  unpin(): void {
    void vscode.workspace.getConfiguration("obsidianlikePreview").update("pinnedNote", "", vscode.ConfigurationTarget.Workspace);
  }

  /**
   * Fija la nota que esté activa ahora mismo (pestaña con foco en el editor principal). Se
   * intentó también soportar arrastrar-y-soltar (una pestaña, o un ítem del Explorer) sobre el
   * panel, pero se comprobó que VS Code no entrega ningún evento `drop` dentro del contenido del
   * webview para un arrastre *interno* — a diferencia de soltar un archivo real desde el
   * explorador del sistema operativo, que sí llega. Ese código se retiró; este comando y la
   * opción `obsidianlikePreview.pinnedNote` son los dos únicos mecanismos para fijar una nota.
   */
  async pinActiveNote(): Promise<void> {
    const doc = await this.tracker.getDocument();
    if (!doc) {
      void vscode.window.showWarningMessage(
        `No hay ninguna nota Markdown activa para fijar. [diagnóstico: ${this.tracker.describeActiveTab()}]`
      );
      return;
    }
    await this.setPinnedNote(doc.uri);
  }

  /** Nota que debe mostrarse: la fijada, si hay una, o si no la de la pestaña activa. */
  private async getTargetDocument(): Promise<vscode.TextDocument | undefined> {
    if (this.pinnedUri) {
      try {
        return await vscode.workspace.openTextDocument(this.pinnedUri);
      } catch (error) {
        log(`getTargetDocument: no se pudo abrir la nota fijada "${this.pinnedUri.fsPath}": ${error}`);
        return undefined;
      }
    }
    return this.tracker.getDocument();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.bindToActiveDocument();
      }
    });
    void this.bindToActiveDocument();
  }

  /** Fuerza una reconstrucción completa, aunque la nota activa sea la misma que ya se muestra. */
  refresh(): void {
    this.boundDocument = undefined;
    void this.bindToActiveDocument();
  }

  /**
   * Se suscribe (una sola vez) a `onDidChangeTasks` de la extensión de tareas, para reenviar
   * `tasks-changed` al webview y que cada bloque ```tasks``` visible se re-consulte cuando una
   * tarea cambia en cualquier otro sitio del vault. Reintenta cada 1.5s unas cuantas veces (igual
   * que `ensureSubscribedToTasksChanges` en `../obsidianlike/src/extension.ts`) por si esta
   * extensión se activa antes de que la de tareas esté lista.
   */
  private async ensureSubscribedToTasksChanges(retriesLeft = 5): Promise<void> {
    if (this.subscribedToTasksChanges) {
      return;
    }
    const api = await getTasksApi();
    if (!api?.onDidChangeTasks) {
      if (retriesLeft > 0) {
        setTimeout(() => void this.ensureSubscribedToTasksChanges(retriesLeft - 1), 1500);
      }
      return;
    }
    this.subscribedToTasksChanges = true;
    api.onDidChangeTasks(() => {
      try {
        this.view?.webview.postMessage({ type: "tasks-changed" });
      } catch {
        /* el webview puede no estar listo todavía */
      }
    });
  }

  private async refreshNoteIndex(): Promise<void> {
    try {
      this.noteIndex = await buildNoteIndex();
      this.view?.webview.postMessage({ type: "note-index", notes: this.noteIndex });
    } catch (error) {
      log(`refreshNoteIndex: ERROR ${error}`);
    }
  }

  private handleExternalChange(e: vscode.TextDocumentChangeEvent): void {
    if (this.applyingOwnEdit || e.contentChanges.length === 0) {
      return;
    }
    if (!this.boundDocument || e.document.uri.toString() !== this.boundDocument.uri.toString()) {
      return;
    }
    this.lastSyncedContent = e.document.getText();
    this.view?.webview.postMessage({ type: "external-update", content: this.lastSyncedContent });
  }

  private async bindToActiveDocument(): Promise<void> {
    if (!this.view) {
      return;
    }
    const requestId = ++this.requestSeq;
    const webview = this.view.webview;

    const obsidianlikeExt = vscode.extensions.getExtension(OBSIDIANLIKE_EXTENSION_ID);
    if (!obsidianlikeExt) {
      this.boundDocument = undefined;
      webview.options = { enableScripts: false };
      webview.html = this.getMessageHtml(
        'Instala y activa la extensión "Obsidian-like" para usar esta vista previa: reutiliza directamente su renderer.'
      );
      return;
    }
    if (!obsidianlikeExt.isActive) {
      try {
        await obsidianlikeExt.activate();
      } catch (error) {
        log(`bindToActiveDocument: no se pudo activar ${OBSIDIANLIKE_EXTENSION_ID}: ${error}`);
      }
    }
    if (requestId !== this.requestSeq) {
      return;
    }

    const document = await this.getTargetDocument();
    if (requestId !== this.requestSeq) {
      return;
    }
    if (!document) {
      this.boundDocument = undefined;
      webview.options = { enableScripts: false };
      webview.html = this.getMessageHtml(
        this.pinnedUri
          ? `No se pudo abrir la nota fijada "${vscode.workspace.asRelativePath(this.pinnedUri, false)}". Corrige o vacía "obsidianlikePreview.pinnedNote" en la configuración.`
          : `No hay ninguna nota Markdown activa. [diagnóstico: ${this.tracker.describeActiveTab()}]`
      );
      return;
    }

    if (this.boundDocument && this.boundDocument.uri.toString() === document.uri.toString()) {
      return;
    }

    this.boundDocument = document;
    this.lastSyncedContent = document.getText();

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(obsidianlikeExt.extensionUri, "out"), ...getAttachmentRoots(document.uri)],
    };
    webview.html = this.buildHtml(webview, document, obsidianlikeExt.extensionUri);
    log(`bindToActiveDocument #${requestId}: mostrando ${document.uri.toString()}`);

    // Igual que `resolveCustomTextEditor` en `obsidianlike`: el tema CSS del vault se manda
    // como mensaje (nunca inline en el HTML) porque puede contener SVGs con "</style>"
    // embebido que rompería el parser si se concatenara en el string del documento.
    setTimeout(() => {
      if (requestId !== this.requestSeq) {
        return;
      }
      const themeCss = this.getThemeCss();
      if (themeCss) {
        this.view?.webview.postMessage({ type: "theme-css", css: themeCss });
      }
    }, 300);
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    const doc = this.boundDocument;
    // Traza de todo lo que llega del webview salvo lo muy frecuente (edición/cursor/scroll) —
    // clave para diagnosticar "pulso un wikilink y no pasa nada": si el `open-note` no aparece
    // aquí, el problema está en `editor.js`/el canal; si aparece, está en el manejo de abajo.
    if (message.type !== "sync" && message.type !== "cursor-position" && message.type !== "scroll-position") {
      log(`handleMessage: ${String(message.type)} ${JSON.stringify(message).slice(0, 300)}`);
    }
    switch (message.type) {
      case "sync":
        await this.applySync(message.content as string);
        return;

      case "open-note": {
        if (!doc) {
          log("open-note: ignorado (no hay nota vinculada al panel todavía)");
          return;
        }
        const raw = ((message.name as string) || "").trim();
        if (!raw) return;
        const basePathRel = (message.basePath as string | undefined)?.trim();
        const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const currentDir =
          basePathRel && vaultRoot ? path.dirname(path.join(vaultRoot, basePathRel)) : path.dirname(doc.uri.fsPath);
        const { notePart, section } = splitTarget(raw);
        let targetUri = await resolveNoteUri(notePart, currentDir);
        if (!targetUri) {
          // Igual que en `obsidianlike`: un wikilink a una nota inexistente la crea.
          const newPath = path.join(currentDir, `${notePart}.md`);
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(newPath)));
            await vscode.workspace.fs.writeFile(vscode.Uri.file(newPath), new Uint8Array());
            targetUri = vscode.Uri.file(newPath);
            log(`open-note: "${notePart}" no existía; creada en "${newPath}"`);
          } catch (error) {
            log(`open-note: no se pudo crear "${newPath}": ${error}`);
            void vscode.window.showErrorMessage(`No se pudo crear la nota "${notePart}": ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
        }
        log(`open-note: "${raw}" -> ${targetUri.fsPath}${section ? ` #${section}` : ""}`);
        await this.openInEditor(targetUri, section);
        return;
      }

      case "open-transclusion": {
        if (!doc) return;
        const raw = ((message.target as string) || "").trim();
        if (!raw) return;
        const { notePart, section } = splitTarget(raw);
        const targetUri = await resolveNoteUri(notePart, path.dirname(doc.uri.fsPath));
        if (!targetUri) {
          log(`open-transclusion: no se encontró ninguna nota para "${raw}"`);
          return;
        }
        log(`open-transclusion: "${raw}" -> ${targetUri.fsPath}${section ? ` #${section}` : ""}`);
        await this.openInEditor(targetUri, section);
        return;
      }

      case "get-transclusion": {
        if (!doc) return;
        await this.handleGetTransclusion(doc, message.id as string, ((message.target as string) || "").trim());
        return;
      }

      case "get-headings": {
        if (!doc) return;
        const id = message.id as string;
        const raw = ((message.note as string) || "").trim();
        try {
          const targetUri = await resolveNoteUri(raw, path.dirname(doc.uri.fsPath));
          if (!targetUri) {
            this.view?.webview.postMessage({ type: "headings-result", id, headings: [] });
            return;
          }
          const text = (await vscode.workspace.openTextDocument(targetUri)).getText();
          const headings = parseHeadings(text).map((h) => ({ level: h.level, text: h.text }));
          this.view?.webview.postMessage({ type: "headings-result", id, headings });
        } catch {
          this.view?.webview.postMessage({ type: "headings-result", id, headings: [] });
        }
        return;
      }

      case "open-url": {
        const url = ((message.url as string) || "").trim();
        if (url) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }

      case "reveal-path": {
        const fsPath = ((message.fsPath as string) || "").trim();
        if (fsPath) {
          void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(fsPath));
        }
        return;
      }

      case "toggle-task": {
        if (!doc) return;
        try {
          const line = message.line as number;
          const lineText = doc.lineAt(line).text;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, doc.lineAt(line).range, naiveToggleTaskLine(lineText));
          this.applyingOwnEdit = true;
          try {
            await vscode.workspace.applyEdit(edit);
          } finally {
            this.applyingOwnEdit = false;
          }
        } catch (error) {
          log(`toggle-task: ERROR ${error}`);
        }
        return;
      }

      case "run-tasks-query": {
        if (!doc) return;
        const query = (message.query as string) || "";
        try {
          const tasksApi = await getTasksApi();
          // Igual que en `../obsidianlike/src/extension.ts`: la ruta relativa de la propia nota
          // que contiene el bloque, para que `{{query.file.path}}` dentro de la query se expanda.
          const queryFilePath = vscode.workspace.asRelativePath(doc.uri, false);
          const result: TasksQueryResultDTO = tasksApi?.renderTasksQuery
            ? tasksApi.renderTasksQuery(query, queryFilePath)
            : { items: [], groups: null, unrecognizedLines: [] };
          this.view?.webview.postMessage({ type: "tasks-query-result", query, result });
        } catch (error) {
          log(`run-tasks-query: ERROR ${error}`);
          this.view?.webview.postMessage({
            type: "tasks-query-result",
            query,
            result: { items: [], groups: null, unrecognizedLines: [] },
          });
        }
        return;
      }

      case "toggle-task-at-location": {
        try {
          const tasksApi = await getTasksApi();
          await tasksApi?.toggleTaskAtLocation?.(message.path as string, message.line as number);
        } catch (error) {
          log(`toggle-task-at-location: ERROR ${error}`);
        }
        return;
      }

      case "edit-task-at-location": {
        try {
          const tasksApi = await getTasksApi();
          if (!tasksApi?.editTaskAtLocation) {
            void vscode.window.showInformationMessage(
              'Editar tareas requiere la extensión "Obsidian-like Tasks" instalada y actualizada.'
            );
            return;
          }
          await tasksApi.editTaskAtLocation(message.path as string, message.line as number);
        } catch (error) {
          log(`edit-task-at-location: ERROR ${error}`);
        }
        return;
      }

      // 'rename' (edición del título H1) y las consultas ```dataview``` no están soportadas
      // desde este panel de vista previa — se ignoran en vez de fallar.
      default:
        return;
    }
  }

  private async handleGetTransclusion(doc: vscode.TextDocument, id: string, raw: string): Promise<void> {
    const { notePart, section } = splitTarget(raw);
    const currentDir = path.dirname(doc.uri.fsPath);
    try {
      const targetUri = notePart.trim() ? await resolveNoteUri(notePart, currentDir) : doc.uri;
      if (!targetUri) {
        this.view?.webview.postMessage({ type: "transclusion-result", id, error: "not-found" });
        return;
      }
      const title = path.basename(targetUri.fsPath, ".md");
      const fullText = (await vscode.workspace.openTextDocument(targetUri)).getText();
      if (!section) {
        this.view?.webview.postMessage({ type: "transclusion-result", id, error: null, content: fullText, title, line: 0 });
        return;
      }
      const headings = parseHeadings(fullText);
      const idx = headings.findIndex((h) => h.text.toLowerCase() === section.toLowerCase());
      if (idx === -1) {
        this.view?.webview.postMessage({ type: "transclusion-result", id, error: "section-not-found", title });
        return;
      }
      const lines = fullText.split(/\r\n|\n/);
      const startLine = headings[idx].line;
      let endLine = lines.length;
      for (let j = idx + 1; j < headings.length; j++) {
        if (headings[j].level <= headings[idx].level) {
          endLine = headings[j].line;
          break;
        }
      }
      const sectionText = lines.slice(startLine, endLine).join("\n");
      this.view?.webview.postMessage({ type: "transclusion-result", id, error: null, content: sectionText, title, line: startLine });
    } catch {
      this.view?.webview.postMessage({ type: "transclusion-result", id, error: "error" });
    }
  }

  /** Aplica el contenido recibido del webview al documento real (edición desde el panel). */
  private async applySync(content: string): Promise<void> {
    const doc = this.boundDocument;
    if (!doc || content === this.lastSyncedContent) {
      return;
    }
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange, content);
    this.applyingOwnEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingOwnEdit = false;
    }
    this.lastSyncedContent = content;
  }

  /**
   * Abre `uri` (opcionalmente en una sección) en el área de editores normal de VS Code —
   * nunca en este panel — usando el editor personalizado de `obsidianlike` para las notas
   * `.md` (su render). Preferencias, en orden:
   *   1. `vaultTool.openNoteAtLine` (comando de `obsidianlike`): `vscode.openWith` con su
   *      viewType + scroll a la sección vía un postMessage retardado (`vscode.open` con
   *      `selection` no funciona sobre ese editor personalizado, de ahí el comando).
   *   2. `vscode.openWith` directo con el viewType, por si el comando no está registrado
   *      (versión antigua de `obsidianlike`) pero el editor sí.
   *   3. `vscode.open` a secas: al estar ese editor como `priority: "default"` para `*.md`,
   *      también acaba usándolo; y para destinos que no sean `.md` es lo correcto igualmente.
   * Cualquier fallo se registra Y se muestra al usuario (antes solo iba al log, así que un
   * wikilink que no abría nada no daba ninguna pista de por qué).
   */
  private async openInEditor(uri: vscode.Uri, section: string | null): Promise<void> {
    let line = 0;
    if (section) {
      try {
        const text = (await vscode.workspace.openTextDocument(uri)).getText();
        const headings = parseHeadings(text);
        const idx = headings.findIndex((h) => h.text.toLowerCase() === section.toLowerCase());
        if (idx !== -1) {
          line = headings[idx].line;
        }
      } catch {
        /* la nota puede no existir todavía (recién creada vacía) */
      }
    }
    const isMarkdown = uri.fsPath.toLowerCase().endsWith(".md");
    try {
      if (isMarkdown) {
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes("vaultTool.openNoteAtLine")) {
          log(`openInEditor: vaultTool.openNoteAtLine("${uri.fsPath}", ${line})`);
          await vscode.commands.executeCommand("vaultTool.openNoteAtLine", uri, line);
          return;
        }
        try {
          log(`openInEditor: vscode.openWith ${OBSIDIANLIKE_MARKDOWN_EDITOR_VIEW_TYPE} ("${uri.fsPath}")`);
          await vscode.commands.executeCommand(
            "vscode.openWith",
            uri,
            OBSIDIANLIKE_MARKDOWN_EDITOR_VIEW_TYPE,
            vscode.ViewColumn.Active
          );
          return;
        } catch (inner) {
          log(`openInEditor: openWith falló (${inner}); pruebo vscode.open`);
        }
      }
      const position = new vscode.Position(line, 0);
      log(`openInEditor: vscode.open ("${uri.fsPath}")`);
      await vscode.commands.executeCommand("vscode.open", uri, {
        viewColumn: vscode.ViewColumn.Active,
        selection: new vscode.Range(position, position),
      });
    } catch (error) {
      log(`openInEditor: ERROR abriendo "${uri.fsPath}": ${error}`);
      void vscode.window.showErrorMessage(
        `No se pudo abrir "${vscode.workspace.asRelativePath(uri, false)}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private getThemeCss(): string {
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const themeName = vscode.workspace.getConfiguration("obsidianLike").get<string>("obsidianTheme", "").trim();
    if (!vaultRoot || !themeName) {
      return "";
    }
    const themesDir = path.join(vaultRoot, ".obsidian", "themes");
    try {
      return fs.readFileSync(path.join(themesDir, themeName, "theme.css"), "utf-8");
    } catch {
      /* intento case-insensitive abajo */
    }
    try {
      for (const name of fs.readdirSync(themesDir)) {
        if (name.toLowerCase() !== themeName.toLowerCase()) continue;
        try {
          return fs.readFileSync(path.join(themesDir, name, "theme.css"), "utf-8");
        } catch {
          /* seguir buscando */
        }
      }
    } catch {
      /* .obsidian/themes no existe */
    }
    return "";
  }

  private buildHtml(webview: vscode.Webview, document: vscode.TextDocument, obsidianlikeExtUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(obsidianlikeExtUri, "out", "editor.bundle.js"));
    const cfg = vscode.workspace.getConfiguration("obsidianLike");
    const font = cfg.get<string>("markdownFont", "").trim() || "var(--vscode-editor-font-family)";
    const codeFont = cfg.get<string>("codeFont", "").trim();
    const codeFontSize = cfg.get<number>("codeFontSize", 14);
    const fontSize = vscode.workspace.getConfiguration("editor").get<number>("fontSize", 14);
    const highlighterColors = cfg.get("highlighterColors", []);
    const highlighterUseCssClasses = cfg.get<boolean>("highlighterUseCssClasses", false);
    const imageMap = getImageMap(webview, document.uri);
    const title = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));

    const init = JSON.stringify({
      content: document.getText(),
      font,
      codeFont,
      codeFontSize,
      fontSize,
      noteIndex: this.noteIndex,
      title,
      imageMap,
      breadcrumb: [],
      recentNotes: [],
      highlighterColors,
      highlighterUseCssClasses,
    });

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data: blob:; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline';">
  <style>
    html, body {
      height: 100%; margin: 0; overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      display: flex; flex-direction: column;
    }
    #doc-breadcrumb {
      flex-shrink: 0;
      max-width: 780px; width: 100%;
      margin: 0 auto; padding: 4px 8px 0; box-sizing: border-box;
      font-size: 11px; opacity: 0.55;
      display: flex; align-items: center; justify-content: center; gap: 2px; flex-wrap: wrap;
      user-select: none;
    }
    .bc-part { cursor: pointer; color: inherit; padding: 2px 6px; }
    .bc-part:hover { opacity: 1; text-decoration: underline; }
    .bc-last { font-weight: 600; opacity: 1; cursor: default; }
    .bc-sep { padding: 2px 2px; opacity: 0.4; }
    #doc-header {
      flex-shrink: 0;
      max-width: 780px; width: 100%;
      margin: 0 auto; padding: 6px 8px 0; box-sizing: border-box;
    }
    #doc-title {
      font-size: 1.5em; font-weight: 700; line-height: 1.3;
      outline: none; background: transparent;
      color: var(--vscode-editor-foreground, #d4d4d4);
      font-family: var(--md-font, var(--vscode-editor-font-family, inherit));
      white-space: pre-wrap; word-break: break-word;
      margin-bottom: 10px; min-height: 1.2em;
      caret-color: var(--vscode-editorCursor-foreground, #aeafad);
    }
    #doc-title:empty::before { content: 'Sin título'; opacity: 0.3; pointer-events: none; }
    #doc-divider {
      border: none;
      border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
      margin: 0;
    }
    #editor { flex: 1; min-height: 0; overflow: hidden; }
    /* editor.js fija .cm-content con max-width:780px y padding:16px 28px 120px vía
       EditorView.theme() — pensado para el editor principal a ancho completo. En este
       panel lateral (normalmente mucho más estrecho que 780px) ese padding lateral es
       el margen visible más grande alrededor de la nota, así que se reduce aquí. Necesita
       !important: la regla de editor.js se inyecta en un <style> propio después de este,
       con la misma especificidad (una clase), y ganaría por orden en el DOM si no. */
    #editor .cm-content {
      max-width: none !important;
      padding: 6px 10px 24px !important;
    }
  </style>
  <style id="__obsidian-theme"></style>
</head>
<body>
  <div id="doc-breadcrumb"></div>
  <div id="doc-header">
    <div id="doc-title" contenteditable="plaintext-only" spellcheck="false"></div>
    <hr id="doc-divider">
  </div>
  <div id="editor" class="is-live-preview markdown-source-view mod-cm6"></div>
  <script>window.__vaultInitial = ${init.replace(/<\/script>/gi, "<\\/script>")};</script>
  <script src="${scriptUri}"></script>
  <script>
    (function () {
      function sync() {
        var b = document.body;
        if (!b) return;
        var dark = b.classList.contains('vscode-dark') || b.classList.contains('vscode-high-contrast');
        b.classList.toggle('theme-dark', dark);
        b.classList.toggle('theme-light', !dark);
      }
      sync();
      new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    })();
  </script>
</body>
</html>`;
  }

  private getMessageHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 14px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  p { opacity: 0.75; line-height: 1.5; }
</style>
</head>
<body><p>${escapeHtml(message)}</p></body>
</html>`;
  }
}
