import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { AstReply, FromWebview } from "./protocol";
import { typeEdits, typeSites } from "./graphTypes";

export async function chooseTypeFromGraph(document: vscode.TextDocument, tree: AstReply,
    message: Extract<FromWebview, { type: "chooseType" }>, client: LanguageClient, active: () => boolean): Promise<void> {
    const unchanged = () => active() && document.version === message.version && document.getText() === tree.source;
    const stale = () => new Error(vscode.l10n.t("The source changed. Choose a type again in the updated graph."));
    if (!unchanged()) throw stale();
    const site = typeSites(tree).find(site => site.start === message.start && site.end === message.end);
    if (!site) throw new Error(vscode.l10n.t("This location cannot have a type annotation."));
    const position = document.positionAt(site.start);
    const reply = await client.sendRequest<{ source: string; candidates: string[] } | null>("lhat/typeOptions", {
        textDocument: { uri: document.uri.toString() }, position: { line: position.line, character: position.character },
    });
    if (!unchanged() || (reply && reply.source !== tree.source)) throw stale();
    if (!reply) throw new Error(vscode.l10n.t("Type candidates are unavailable. Update or restart the language server."));
    const items: (vscode.QuickPickItem & { typeText?: string })[] = [...new Set(reply.candidates)]
        .filter(text => typeof text === "string" && text.length > 0)
        .map(text => ({ label: text, typeText: text,
            description: site.explicit && text === site.typeText ? vscode.l10n.t("Current annotation") : undefined }));
    if (site.explicit && !site.required) items.unshift({ label: vscode.l10n.t("Use inferred type"),
        description: vscode.l10n.t("Remove the annotation") });
    if (!items.length) throw new Error(vscode.l10n.t("No compatible types are available at this location."));
    const selected = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("Type of {0}", site.name),
        placeHolder: vscode.l10n.t("Filter compatible types; select to write an annotation"),
        matchOnDescription: true,
    });
    if (!selected) return;
    if (!unchanged()) throw stale();
    const edits = typeEdits(site, selected.typeText);
    const edit = new vscode.WorkspaceEdit();
    for (const change of edits) edit.replace(document.uri,
        new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
    if (edits.length && !await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not apply the type annotation."));
}
