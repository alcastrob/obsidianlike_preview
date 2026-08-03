import * as vscode from "vscode";
import { ActiveMarkdownDocumentTracker } from "./activeMarkdownDocument";
import { log, outputChannel } from "./log";
import { PanelViewProvider } from "./views/panelViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);
  log("activate()");

  const tracker = new ActiveMarkdownDocumentTracker(context);
  const panelViewProvider = new PanelViewProvider(tracker, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("obsidianlikePreview.panelView", panelViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("obsidianlikePreview.refresh", () => panelViewProvider.refresh()),
    vscode.commands.registerCommand("obsidianlikePreview.pinActive", () => panelViewProvider.pinActiveNote()),
    vscode.commands.registerCommand("obsidianlikePreview.unpin", () => panelViewProvider.unpin())
  );
}

export function deactivate(): void {
  // Nada que limpiar: todos los listeners se registran en context.subscriptions.
}
