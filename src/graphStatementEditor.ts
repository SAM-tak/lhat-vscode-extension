import { editTextField } from "./graphTextFields";
import { editComment } from "./graphComments";
import { copyGraphFragment, cutGraphFragment, pasteGraphFragment, externalGraphFragment, type ClipboardFragment } from "./graphClipboard";
import { editStructure } from "./graphStructure";
import { deleteFromGraph } from "./graphDelete";
import { replaceExpression } from "./graphExpressions";
import { editLiteral } from "./graphLiterals";
import { editAnnotation } from "./graphAnnotations";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { AstReply, FromWebview } from "./protocol";
import { insertStatementEdit, statementSites } from "./graphStatements";
import { insertListEdit, replaceOperatorEdit } from "./graphLists";
import { editInterpolation } from "./graphInterpolation";

type StatementRequest = Extract<FromWebview, { type: "insertStatement" | "toggleStatement" | "insertElement" | "replaceOperator" | "editInterpolation" | "editAnnotation" | "editLiteral" | "replaceExpression" | "deleteElement" | "editStructure" | "editTextField" | "editComment" | "clipboard" }>;
let copied: ClipboardFragment | undefined;

/** Every graph statement edit is validated against the displayed source and has one undo step. */
export async function editStatementFromGraph(document: vscode.TextDocument, tree: AstReply,
    message: StatementRequest, client: LanguageClient | undefined, active: () => boolean): Promise<void> {
    const unchanged = () => active() && document.version === message.version && document.getText() === tree.source;
    const check = () => {
        if (!unchanged()) throw new Error(vscode.l10n.t("The source changed. Try again in the updated graph."));
    };
    check();
    if (message.type === "clipboard") {
        let change;
        if (message.action === "paste") {
            const text = await vscode.env.clipboard.readText();
            check();
            change = pasteGraphFragment(tree, message.target, copied?.text === text ? copied : externalGraphFragment(text), message.insert);
        } else {
            const fragment = copyGraphFragment(tree, message.target);
            if (!fragment) throw new Error(vscode.l10n.t("This edit is not available at this location."));
            change = message.action === "cut" ? cutGraphFragment(tree, message.target) : undefined;
            if (message.action === "cut" && !change) throw new Error(vscode.l10n.t("This edit is not available at this location."));
            await vscode.env.clipboard.writeText(fragment.text);
            copied = fragment;
            check();
            if (message.action === "copy") return;
        }
        if (!change) throw new Error(vscode.l10n.t("This edit is not available at this location."));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
        check();
        if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not apply the statement edit."));
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    if (message.type !== "toggleStatement") {
        const change = message.type === "insertStatement" ? insertStatementEdit(tree, message.site, message.template)
             : message.type === "insertElement" ? insertListEdit(tree, message.site, message.template)
            : message.type === "editTextField" ? editTextField(tree, message.site, message.value)
            : message.type === "editComment" ? editComment(tree, message.site, message.action)
            : message.type === "editStructure" ? editStructure(tree, message.site, message.action)
            : message.type === "deleteElement" ? deleteFromGraph(tree, message.site)
            : message.type === "replaceExpression" ? replaceExpression(tree, message.site, message.template)
            : message.type === "editLiteral" ? editLiteral(tree, message.key, message.value)
            : message.type === "editAnnotation" ? editAnnotation(tree, message)
            : message.type === "editInterpolation" ? editInterpolation(tree, message.site, message.value)
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
