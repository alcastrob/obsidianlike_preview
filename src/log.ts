import * as vscode from "vscode";

/**
 * Canal de salida compartido para diagnóstico. Ver View > Output > "Obsidian-like Preview".
 */
export const outputChannel = vscode.window.createOutputChannel("Obsidian-like Preview");

export function log(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 23);
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}
