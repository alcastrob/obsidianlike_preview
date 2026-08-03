import * as vscode from "vscode";
import { log } from "./log";

/** Extrae la Uri del archivo de una pestaña, sea cual sea el tipo de editor que la muestre. */
function getTabUri(input: unknown): vscode.Uri | undefined {
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputNotebook
  ) {
    return input.uri;
  }
  return undefined;
}

/**
 * Documento Markdown de la pestaña activa. Deliberadamente NO usa
 * `vscode.window.activeTextEditor` (pasa a `undefined` en cuanto el foco sale
 * de un editor de texto, p.ej. al hacer clic en este mismo panel). En su lugar
 * usa la pestaña activa de `vscode.window.tabGroups`, que no depende del foco.
 *
 * Tampoco exige que la pestaña sea un editor de texto plano (`TabInputText`):
 * un archivo .md puede mostrarse con el editor personalizado de la extensión
 * hermana `obsidianlike` (`TabInputCustom`) y sigue siendo el mismo archivo.
 * Se resuelve la Uri con `openTextDocument` (idempotente: si ya está abierto
 * devuelve la misma instancia al instante) en vez de compararla a mano contra
 * `workspace.textDocuments`.
 *
 * Copiado tal cual de `obsidianlike_links/src/activeMarkdownDocument.ts` — ver
 * el CLAUDE.md de ese proyecto para el historial completo de por qué existen
 * el debounce y el sondeo de abajo (bug real, ya corregido, en el timing de
 * los eventos de pestaña de `obsidianlike` con su editor personalizado).
 */
const TAB_SETTLE_DELAY_MS = 150;
const POLL_INTERVAL_MS = 400;

export class ActiveMarkdownDocumentTracker {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastNotifiedKey: string | undefined;

  constructor(context: vscode.ExtensionContext) {
    const scheduleChange = (source: string) => {
      log(`${source} — pendiente de asentarse`);
      if (this.settleTimer) {
        clearTimeout(this.settleTimer);
      }
      this.settleTimer = setTimeout(() => {
        this.settleTimer = undefined;
        this.checkActiveTab("evento");
      }, TAB_SETTLE_DELAY_MS);
    };
    const pollTimer = setInterval(() => this.checkActiveTab("sondeo"), POLL_INTERVAL_MS);
    context.subscriptions.push(
      { dispose: () => this.settleTimer && clearTimeout(this.settleTimer) },
      { dispose: () => clearInterval(pollTimer) },
      vscode.window.tabGroups.onDidChangeTabGroups((e) => {
        log(`onDidChangeTabGroups (opened=${e.opened.length}, closed=${e.closed.length}, changed=${e.changed.length})`);
        scheduleChange("onDidChangeTabGroups");
      }),
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        log(`onDidChangeTabs (opened=${e.opened.length}, closed=${e.closed.length}, changed=${e.changed.length})`);
        scheduleChange("onDidChangeTabs");
      })
    );
  }

  /** Compara la pestaña activa actual con la última notificada; si difiere, dispara `onDidChange`. */
  private checkActiveTab(source: string): void {
    const uri = getTabUri(vscode.window.tabGroups.activeTabGroup?.activeTab?.input);
    const key = uri?.toString() ?? "";
    if (key === this.lastNotifiedKey) {
      return;
    }
    log(`(${source}) pestaña activa cambió: "${this.lastNotifiedKey ?? "-"}" -> "${key || "(ninguna)"}"`);
    this.lastNotifiedKey = key;
    this._onDidChange.fire();
  }

  async getDocument(): Promise<vscode.TextDocument | undefined> {
    const uri = getTabUri(vscode.window.tabGroups.activeTabGroup?.activeTab?.input);
    if (!uri) {
      log(`getDocument: sin uri (${this.describeActiveTab()})`);
      return undefined;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      log(`getDocument: uri=${uri.toString()} languageId=${document.languageId}`);
      return document.languageId === "markdown" ? document : undefined;
    } catch (error) {
      log(`getDocument: openTextDocument("${uri.toString()}") lanzó un error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      throw error;
    }
  }

  /** Info de diagnóstico sobre por qué no se detectó ningún documento Markdown activo. */
  describeActiveTab(): string {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      return "sin pestaña activa en tabGroups";
    }
    const input = activeTab.input;
    const uri = getTabUri(input);
    if (!uri) {
      return `pestaña activa "${activeTab.label}" tiene un tipo de editor no reconocido (${input?.constructor?.name ?? typeof input})`;
    }
    if (input instanceof vscode.TabInputCustom) {
      return `pestaña "${activeTab.label}" es un editor personalizado (viewType=${input.viewType}), uri=${uri.toString()}`;
    }
    return `pestaña activa: ${uri.toString()}`;
  }
}
