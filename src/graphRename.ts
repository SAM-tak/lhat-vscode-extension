import * as vscode from "vscode";
import type { FromWebview } from "./protocol";

/** Use the registered LSP provider, never textual search/replace or serialization. */
export async function renameFromGraph(document: vscode.TextDocument,
    message: Extract<FromWebview, { type: "rename" }>, active: () => boolean): Promise<void> {
    const unchanged = () => active() && document.version === message.version &&
        Number.isInteger(message.start) && Number.isInteger(message.end) &&
        message.start >= 0 && message.end > message.start &&
        document.getText().slice(message.start, message.end) === message.oldName;
    const stale = () => new Error(vscode.l10n.t("The source changed. Try renaming again in the updated graph."));
    if (!unchanged()) throw stale();
    if (typeof message.newName !== "string" || message.newName.length === 0) {
        throw new Error(vscode.l10n.t("Enter a name."));
    }
    if (message.newName === message.oldName) return;
    const versions = new Map(vscode.workspace.textDocuments.map(doc => [doc, doc.version]));
    const position = document.positionAt(message.start);
    const prepared = await vscode.commands.executeCommand<vscode.Range | { range: vscode.Range }>(
        "vscode.prepareRename", document.uri, position);
    if (!unchanged()) throw stale();
    const range = prepared && ("range" in prepared ? prepared.range : prepared);
    if (!range || document.offsetAt(range.start) !== message.start || document.offsetAt(range.end) !== message.end) {
        throw new Error(vscode.l10n.t("This name cannot be renamed by the language server."));
    }
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider", document.uri, position, message.newName);
    if (!unchanged() || [...versions].some(([doc, version]) => doc.version !== version)) throw stale();
    if (!edit || edit.size === 0) throw new Error(vscode.l10n.t("The language server did not accept this name."));
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not apply the rename."));
}
