import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { AstReply, FromWebview } from "./protocol";
import { insertStatementEdit, statementSites } from "./graphStatements";
import { insertListEdit, replaceOperatorEdit } from "./graphLists";

type StatementRequest = Extract<FromWebview, { type: "insertStatement" | "toggleStatement" | "insertElement" | "replaceOperator" }>;

/** Every graph statement edit is validated against the displayed source and has one undo step. */
export async function editStatementFromGraph(document: vscode.TextDocument, tree: AstReply,
    message: StatementRequest, client: LanguageClient | undefined, active: () => boolean): Promise<void> {
    const unchanged = () => active() && document.version === message.version && document.getText() === tree.source;
    const check = () => {
        if (!unchanged()) throw new Error(vscode.l10n.t("The source changed. Try again in the updated graph."));
    };
    check();
    const edit = new vscode.WorkspaceEdit();
    if (message.type !== "toggleStatement") {
        const change = message.type === "insertStatement" ? insertStatementEdit(tree, message.site, message.template)
            : message.type === "insertElement" ? insertListEdit(tree, message.site, message.template)
            : replaceOperatorEdit(tree, message, message.operator);
        if (!change) throw new Error(vscode.l10n.t("This edit is not available at this location."));
        edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
    } else {
        if (!statementSites(tree).some(site => site.start === message.start && site.end === message.end)) {
            throw new Error(vscode.l10n.t("Select a statement in the updated graph."));
        }
        if (!client) throw new Error(vscode.l10n.t("The language server is not running."));
        type Reply = { exact?: boolean; edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[] } | { refusal: string } | null;
        const reply = await client.sendRequest<Reply>("lhat/toggleDisabledCode", {
            exact: true,
            textDocument: { uri: document.uri.toString() }, range: {
                start: document.positionAt(message.start), end: document.positionAt(message.end),
            },
        });
        check();
        if (!reply || "refusal" in reply) throw new Error(reply?.refusal ?? vscode.l10n.t("Could not toggle this statement."));
        if (reply.exact !== true) throw new Error(vscode.l10n.t("Update or restart the language server to toggle individual statements."));
        for (const change of reply.edits) edit.replace(document.uri, new vscode.Range(
            new vscode.Position(change.range.start.line, change.range.start.character),
            new vscode.Position(change.range.end.line, change.range.end.character)), change.newText);
    }
    check();
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not apply the statement edit."));
}
