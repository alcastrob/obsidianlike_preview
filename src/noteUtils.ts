import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

/** Escapa metacaracteres de glob (`[...]`, `{...}`) para que un nombre de nota los trate como texto literal. */
export function escapeGlob(name: string): string {
  return name.replace(/[[\]{}]/g, "\\$&");
}

/** Separa "nota#sección" (usado por [[nota#sección]] y ![[nota#sección]]) del nombre puro de la nota. */
export function splitTarget(raw: string): { notePart: string; section: string | null } {
  const idx = raw.indexOf("#");
  if (idx === -1) {
    return { notePart: raw, section: null };
  }
  return { notePart: raw.slice(0, idx), section: raw.slice(idx + 1).trim() || null };
}

/** Separa "carpeta/nota" en el nombre de nota y la carpeta usada como pista de desambiguación. */
function splitDirHint(notePart: string): { noteName: string; dirHint: string | null } {
  const normalized = notePart.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const noteName = segments.pop() || normalized;
  const dirHint = segments.length > 0 ? segments[segments.length - 1] : null;
  return { noteName, dirHint };
}

/**
 * Resuelve un target de wikilink/transclusión por nombre de archivo, buscando en
 * todo el workspace (igual que `obsidianlike`) — `dirHint`/`currentDir` solo
 * desempatan cuando varias notas comparten nombre.
 */
export async function resolveNoteUri(notePart: string, currentDir: string): Promise<vscode.Uri | undefined> {
  const { noteName, dirHint } = splitDirHint(notePart);
  const found = await vscode.workspace.findFiles(`**/${escapeGlob(noteName)}.md`, "**/node_modules/**");
  if (found.length === 0) {
    return undefined;
  }
  if (found.length === 1) {
    return found[0];
  }
  if (dirHint) {
    const dirMatch = found.find((u) => path.basename(path.dirname(u.fsPath)).toLowerCase() === dirHint.toLowerCase());
    if (dirMatch) {
      return dirMatch;
    }
  }
  const sameDirMatch = found.find((u) => path.dirname(u.fsPath) === currentDir);
  return sameDirMatch ?? found[0];
}

/** Encabezados ATX (# .. ######), ignorando bloques de código. `line` es 0-based. */
export function parseHeadings(text: string): Array<{ level: number; text: string; line: number }> {
  const lines = text.split(/\r\n|\n/);
  const headings: Array<{ level: number; text: string; line: number }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim(), line: i });
    }
  }
  return headings;
}

/** Índice de notas del workspace para el sugeridor [[ ]] y la coloración de enlaces resueltos/rotos. */
export async function buildNoteIndex(): Promise<Array<{ name: string; dir: string }>> {
  const uris = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return uris.map((uri) => {
    const relDir = vaultRoot ? path.relative(vaultRoot, path.dirname(uri.fsPath)) : "";
    return { name: path.basename(uri.fsPath, ".md"), dir: relDir === "." ? "" : relDir };
  });
}

function findImageFiles(dir: string, fileList: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      // Reparse points (OneDrive/Dropbox placeholders) pueden reportarse mal vía Dirent.
      try {
        const st = fs.statSync(fullPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      findImageFiles(fullPath, fileList);
    } else if (isFile && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/** Raíces locales que el webview puede cargar como recurso (vault + carpeta de adjuntos configurada). */
export function getAttachmentRoots(docUri: vscode.Uri): vscode.Uri[] {
  const cfg = vscode.workspace.getConfiguration("obsidianLike");
  const location = cfg.get<string>("attachmentsLocation", "vault");
  const folder = cfg.get<string>("attachmentsFolder", "attachments");
  const docDir = path.dirname(docUri.fsPath);
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
  const roots: string[] = [vaultRoot, docDir];
  if (location === "subfolder") {
    roots.push(path.join(docDir, folder));
  }
  if (location === "specificfolder") {
    roots.push(path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder));
  }
  return [...new Set(roots)].map((r) => vscode.Uri.file(r));
}

/** Mapa nombre-de-archivo -> Uri de webview, para resolver `![[imagen.png]]`. */
export function getImageMap(webview: vscode.Webview, docUri: vscode.Uri): Record<string, string> {
  const map: Record<string, string> = {};
  const addFile = (fullPath: string) => {
    const name = path.basename(fullPath);
    if (!(name in map)) {
      map[name] = webview.asWebviewUri(vscode.Uri.file(fullPath)).toString();
    }
  };
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(docUri.fsPath);
  for (const fullPath of findImageFiles(path.dirname(docUri.fsPath))) {
    addFile(fullPath);
  }
  for (const fullPath of findImageFiles(vaultRoot)) {
    addFile(fullPath);
  }
  return map;
}
