import * as vscode from "vscode";
import type { AstReply, FromWebview } from "./protocol";
import { reorderEdit } from "./graphReorder";

/** Apply one graph drag as a single source edit; ELK will place the new tree. */
export async function reorderFromGraph(document: vscode.TextDocument, tree: AstReply,
    message: Extract<FromWebview, { type: "reorder" }>, active: () => boolean): Promise<void> {
    const unchanged = () => active() && document.version === message.version && document.getText() === tree.source;
    if (!unchanged()) throw new Error(vscode.l10n.t("The source changed. Drag again in the updated graph."));
    const edit = reorderEdit(tree, message);
    if (edit === undefined) throw new Error(vscode.l10n.t("This item cannot be moved to that location."));
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, new vscode.Range(
        document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
    if (!unchanged()) throw new Error(vscode.l10n.t("The source changed. Drag again in the updated graph."));
    if (!await vscode.workspace.applyEdit(workspaceEdit)) {
        throw new Error(vscode.l10n.t("Could not apply the reorder."));
    }
}
