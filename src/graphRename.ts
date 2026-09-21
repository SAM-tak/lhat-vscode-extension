import * as vscode from "vscode";
import type { AstReply, FromWebview } from "./protocol";
import { typeSites } from "./graphTypes";

/** Use the registered LSP provider, never textual search/replace or serialization. */
export async function renameFromGraph(document: vscode.TextDocument,
    message: Extract<FromWebview, { type: "rename" }>, active: () => boolean, tree?: AstReply): Promise<void> {
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
    // Discards have no symbol or references to rename. Materialize just this
    // declaration, using the same version/span checks as every graph edit.
    if (message.oldName === "_^" && tree?.source === document.getText() &&
        typeSites(tree).some(site => site.start === message.start && site.end === message.end)) {
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(message.newName)) {
            throw new Error(vscode.l10n.t("The language server did not accept this name."));
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(message.start), document.positionAt(message.end)), message.newName);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not apply the rename."));
        return;
    }
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
