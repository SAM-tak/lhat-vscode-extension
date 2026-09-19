import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { AstReply, FromWebview, TypeSite } from "./protocol";
import { typeEdits, typeSites } from "./graphTypes";

export interface TypeSelection {
    id: string;
    version: number;
    source: string;
    site: TypeSite;
    candidates: string[];
}
const stale = () => new Error(vscode.l10n.t("The source changed. Choose a type again in the updated graph."));

function selectionAt(document: vscode.TextDocument, tree: AstReply,
    message: Extract<FromWebview, { type: "chooseType" | "removeType" }>, active: () => boolean): TypeSelection {
    if (!active() || document.version !== message.version || document.getText() !== tree.source) throw stale();
    const site = typeSites(tree).find(site => site.start === message.start && site.end === message.end && site.result?.index === message.resultIndex);
    if (!site) throw new Error(vscode.l10n.t("This location cannot have a type annotation."));
    return { id: message.id, version: message.version, source: tree.source, site, candidates: [] };
}

/** Removal needs a matching syntax snapshot, not a successful type check. */
export async function removeTypeFromGraph(document: vscode.TextDocument, tree: AstReply,
    message: Extract<FromWebview, { type: "removeType" }>, active: () => boolean): Promise<void> {
    await applyTypeFromGraph(document, selectionAt(document, tree, message, active), undefined, active);
}

/** Fetching choices never opens workbench UI or writes to the document. */
export async function typeOptionsFromGraph(document: vscode.TextDocument, tree: AstReply,
    message: Extract<FromWebview, { type: "chooseType" }>, client: LanguageClient,
    active: () => boolean, token: vscode.CancellationToken): Promise<TypeSelection> {
    const unchanged = () => active() && !token.isCancellationRequested &&
        document.version === message.version && document.getText() === tree.source;
    if (!unchanged()) throw stale();
    const selection = selectionAt(document, tree, message, active);
    const site = selection.site;
    const position = document.positionAt(site.result?.owner ?? site.start);
    // A checked unit can be briefly unavailable while the worker replaces it.
    // Retry only null replies, never after a source edit or dismissal.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (!unchanged()) throw stale();
        const reply = await client.sendRequest<{ source: string; candidates: string[] } | null>("lhat/typeOptions", {
            textDocument: { uri: document.uri.toString() }, position: { line: position.line, character: position.character },
            ...(site.result ? { resultIndex: site.result.index } : {}),
        }, token);
        if (!unchanged() || (reply && reply.source !== tree.source)) throw stale();
        if (reply) return { ...selection,
            candidates: [...new Set(reply.candidates)].filter(text => typeof text === "string" && text.length > 0) };
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
    throw new Error(vscode.l10n.t("Type candidates are unavailable at this location. Retry, or update the language server if this persists."));
}

/** Accept only a choice offered for this exact document snapshot. */
export async function applyTypeFromGraph(document: vscode.TextDocument, selection: TypeSelection,
    typeText: string | undefined, active: () => boolean): Promise<void> {
    if (!active() || document.version !== selection.version || document.getText() !== selection.source) throw stale();
    const { site, candidates } = selection;
    if (typeText === undefined ? !site.explicit || site.required : !candidates.includes(typeText)) {
        throw new Error(vscode.l10n.t("Choose one of the available types."));
    }
    const edits = typeEdits(site, typeText);
    const edit = new vscode.WorkspaceEdit();
    for (const change of edits) edit.replace(document.uri,
        new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
    if (edits.length && !await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not apply the type annotation."));
}
