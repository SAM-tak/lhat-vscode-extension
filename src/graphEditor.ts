// L^ (lhat) -- the graph view of a .lh file (06).
//
// A CustomTextEditorProvider rather than a plain webview panel: the document
// stays a text document, so the text editor and the graph are two views of
// one thing and VSCode handles saving, undo and dirty state. Name edits use
// the rename provider, type annotations use WorkspaceEdit, and literal edits
// remain graph-only.
//
// The webview cannot reach lhatls (07 の L3), so this asks on its behalf and
// forwards the answer.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { AstReply, FromWebview, ToWebview } from "./protocol";
import { renameFromGraph } from "./graphRename";
import { referenceFromGraph } from "./graphReference";
import { applyTypeFromGraph, removeTypeFromGraph, typeOptionsFromGraph, type TypeSelection } from "./graphTypeEditor";
import { reorderFromGraph } from "./graphReorderEditor";
import { editStatementFromGraph } from "./graphStatementEditor";
import { graphTreeForDocument } from "./graphSource";

type StatementRequest = Extract<FromWebview, { type: "insertStatement" | "toggleStatement" | "insertElement" | "replaceOperator" }>;

export class LhatGraphEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = "lhat.graph";

    /**
     * The live graphs, by the file each is showing. The outline (outline.ts)
     * needs to reach into one from outside the editor, and a resource can
     * have a graph in more than one group.
     */
    private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
    private readonly statementEditors = new Map<vscode.WebviewPanel, (message: StatementRequest) => void>();

    /** Native webview context menus carry the exact clicked statement, not a text-editor selection. */
    public toggleStatement(context: Record<string, unknown> | undefined): void {
        if (!context || typeof context.lhatGraphUri !== "string" ||
            !Number.isInteger(context.lhatStatementStart) || !Number.isInteger(context.lhatStatementEnd) ||
            !Number.isInteger(context.lhatGraphVersion)) return;
        const panels = [...this.panels.get(context.lhatGraphUri) ?? []];
        const panel = panels.find(panel => panel.active) ?? panels[0];
        if (panel) this.statementEditors.get(panel)?.({ type: "toggleStatement", id: `toggle-${Date.now()}`,
            start: context.lhatStatementStart as number, end: context.lhatStatementEnd as number,
            version: context.lhatGraphVersion as number });
    }

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly client: () => LanguageClient | undefined,
    ) { }

    /** Show what this span covers, in every graph open on that file. */
    public focus(uri: vscode.Uri, start: number, end: number): void {
        for (const panel of this.panels.get(uri.toString()) ?? []) {
            void panel.webview.postMessage(
                { type: "focus", start, end } satisfies ToWebview);
        }
    }

    /** The graph may use a bundled language independently of the workbench. */
    private async localization(uri: vscode.Uri): Promise<Extract<ToWebview, { type: "localization" }>> {
        const language = vscode.workspace.getConfiguration("lhat.graph", uri).get<string>("language", "auto");
        if (language === "en") return { type: "localization", language: "en" };
        if (language === "ja") {
            try {
                const bytes = await vscode.workspace.fs.readFile(
                    vscode.Uri.joinPath(this.context.extensionUri, "l10n", "bundle.l10n.ja.json"));
                const bundle: Record<string, string> = JSON.parse(Buffer.from(bytes).toString("utf8"));
                return { type: "localization", language: "ja", bundle };
            } catch (error) {
                // A missing/damaged package must not prevent the graph opening.
                console.warn("L^: could not load the graph's Japanese translation; using English.", error);
                return { type: "localization", language: "en" };
            }
        }
        // Unset/auto (and invalid hand-written settings) use VS Code's bundle.
        return { type: "localization", language: vscode.env.language, bundle: vscode.l10n.bundle };
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        panel.webview.html = this.html(panel.webview);

        const key = document.uri.toString();
        let open = this.panels.get(key);
        if (open === undefined) {
            open = new Set();
            this.panels.set(key, open);
        }
        open.add(panel);

        let ready = false;
        let disposed = false;
        let initialTreeRequested = false;
        let localizationRevision = 0;
        let treeRevision = 0;
        let treeRetry: ReturnType<typeof setTimeout> | undefined;
        let treeRetryDelay = 100;
        let renaming = false;
        let typeRequest: { id: string; cancel: vscode.CancellationTokenSource;
            timeout?: ReturnType<typeof setTimeout> } | undefined;
        let typeSelection: TypeSelection | undefined;
        let applyingType = false;
        let reordering = false;
        let editingStatement = false;
        let referenceRevision = 0;
        let currentTree: AstReply | undefined;
        const cancelTypeRequest = () => {
            clearTimeout(typeRequest?.timeout);
            typeRequest?.cancel.cancel();
            typeRequest?.cancel.dispose();
            typeRequest = undefined;
        };
        const post = (message: ToWebview) => {
            if (!disposed) void panel.webview.postMessage(message);
        };

        const send = async (): Promise<void> => {
            if (disposed) return;
            clearTimeout(treeRetry);
            treeRetry = undefined;
            const revision = ++treeRevision;
            const version = document.version;
            const client = this.client();
            if (client === undefined) {
                post({ type: "error", message: vscode.l10n.t("The language server is not running.") });
                return;
            }
            try {
                // 06 の 4.3: null until the unit is part of a checked root.
                const reply = await client.sendRequest<AstReply | null>("lhat/ast", {
                    textDocument: { uri: document.uri.toString() },
                });
                if (disposed || revision !== treeRevision || document.version !== version) return;
                const matched = reply === null ? undefined : graphTreeForDocument(reply, document.getText());
                currentTree = matched ?? reply ?? undefined;
                const fresh = matched !== undefined;
                post(reply === null
                    ? { type: "pending" }
                    : { type: "tree", reply: matched ?? reply, uri: document.uri.toString(),
                        version: fresh ? version : undefined });
                if (fresh) treeRetryDelay = 100;
                else {
                    // didChange only queues checking. Its immediate AST may
                    // still be the old snapshot; don't leave all editing
                    // disabled until the user happens to change text again.
                    treeRetry = setTimeout(() => { void send(); }, treeRetryDelay);
                    treeRetryDelay = Math.min(treeRetryDelay * 2, 1000);
                }
            } catch (error: unknown) {
                if (disposed || revision !== treeRevision || document.version !== version) return;
                const reason = error instanceof Error ? error.message : String(error);
                post({ type: "error", message: vscode.l10n.t("lhat/ast failed: {0}", reason) });
            }
        };

        const sendLocalization = async (): Promise<void> => {
            const revision = ++localizationRevision;
            const message = await this.localization(document.uri);
            if (disposed || revision !== localizationRevision) return;
            post(message);
            // Wait for the latest language even if settings change during
            // the initial file read. Never clear edits by resending the AST
            // just to change a label's display language.
            if (!initialTreeRequested) {
                initialTreeRequested = true;
                void send();
            }
        };

        const editStatement = (message: StatementRequest) => {
            if (editingStatement || !currentTree) {
                post({ type: "statementResult", id: message.id, error: vscode.l10n.t("Select a statement in the updated graph.") });
                return;
            }
            editingStatement = true;
            void editStatementFromGraph(document, currentTree, message, this.client(), () => !disposed).then(() => {
                post({ type: "statementResult", id: message.id });
                void send();
            }, (error: unknown) => {
                post({ type: "statementResult", id: message.id, error: error instanceof Error ? error.message : String(error) });
            }).finally(() => { editingStatement = false; });
        };
        this.statementEditors.set(panel, editStatement);

        // Start a new snapshot request on edits; send() follows the checker
        // until it catches up, even when diagnostics themselves don't change.
        const changed = vscode.workspace.onDidChangeTextDocument((event) => {
            if (initialTreeRequested && event.document.uri.toString() === document.uri.toString()) {
                treeRetryDelay = 100;
                void send();
            }
        });
        const configurationChanged = vscode.workspace.onDidChangeConfiguration((event) => {
            if (ready && event.affectsConfiguration("lhat.graph.language", document.uri)) {
                void sendLocalization();
            }
        });
        panel.onDidDispose(() => {
            disposed = true;
            clearTimeout(treeRetry);
            cancelTypeRequest();
            changed.dispose();
            configurationChanged.dispose();
            this.statementEditors.delete(panel);
            open.delete(panel);
            if (open.size === 0) this.panels.delete(key);
        });

        panel.webview.onDidReceiveMessage((message: FromWebview) => {
            switch (message.type) {
                case "ready":
                    // The Webview has no VS Code API. Send the selected bundle
                    // before its first tree so labels and layout share a language.
                    ready = true;
                    initialTreeRequested = false;
                    void sendLocalization();
                    break;
                case "refresh":
                    if (initialTreeRequested) void send();
                    break;
                case "insertStatement":
                case "insertElement":
                case "replaceOperator":
                case "toggleStatement":
                    editStatement(message);
                    break;
                case "reveal":
                    void this.reveal(document, message.start, message.end);
                    break;
                case "rename":
                    if (renaming) {
                        post({ type: "renameResult", id: message.id, error: vscode.l10n.t("Another rename is in progress.") });
                        break;
                    }
                    renaming = true;
                    void renameFromGraph(document, message, () => !disposed, currentTree).then(() => {
                        post({ type: "renameResult", id: message.id });
                        void send();
                    }, (error: unknown) => {
                        post({ type: "renameResult", id: message.id,
                            error: error instanceof Error ? error.message : String(error) });
                    }).finally(() => { renaming = false; });
                    break;
                case "chooseType": {
                    const client = this.client();
                    cancelTypeRequest();
                    typeSelection = undefined;
                    if (applyingType || !currentTree || !client) {
                        post({ type: "typeOptions", id: message.id, error: vscode.l10n.t("Type editing is not available yet.") });
                        break;
                    }
                    const request: NonNullable<typeof typeRequest> = { id: message.id, cancel: new vscode.CancellationTokenSource() };
                    typeRequest = request;
                    const active = () => !disposed && typeRequest === request;
                    request.timeout = setTimeout(() => {
                        if (!active()) return;
                        cancelTypeRequest();
                        post({ type: "typeOptions", id: message.id, error: vscode.l10n.t("Loading types took too long. Please retry.") });
                    }, 12000);
                    void typeOptionsFromGraph(document, currentTree, message, client, active, request.cancel.token).then(selection => {
                        if (!active()) return;
                        typeSelection = selection;
                        post({ type: "typeOptions", id: message.id, candidates: selection.candidates });
                    }, (error: unknown) => {
                        if (active()) post({ type: "typeOptions", id: message.id, error: error instanceof Error ? error.message : String(error) });
                    }).finally(() => {
                        clearTimeout(request.timeout);
                        request.cancel.dispose();
                        if (typeRequest === request) typeRequest = undefined;
                    });
                    break;
                }
                case "cancelType":
                    if (typeRequest?.id === message.id) {
                        cancelTypeRequest();
                    }
                    if (typeSelection?.id === message.id) typeSelection = undefined;
                    break;
                case "applyType":
                case "removeType": {
                    const selection = typeSelection;
                    if (applyingType || (message.type === "applyType" ? selection?.id !== message.id : !currentTree)) {
                        post({ type: "typeResult", id: message.id, error: vscode.l10n.t("Choose a type again in the updated graph.") });
                        break;
                    }
                    applyingType = true;
                    typeSelection = undefined;
                    cancelTypeRequest();
                    const change = message.type === "removeType"
                        ? removeTypeFromGraph(document, currentTree!, message, () => !disposed)
                        : applyTypeFromGraph(document, selection!, message.typeText, () => !disposed);
                    void change.then(() => {
                        post({ type: "typeResult", id: message.id });
                        void send();
                    }, (error: unknown) => {
                        post({ type: "typeResult", id: message.id, error: error instanceof Error ? error.message : String(error) });
                    }).finally(() => { applyingType = false; });
                    break;
                }
                case "reorder":
                    if (reordering || !currentTree) {
                        post({ type: "reorderResult", id: message.id,
                            error: vscode.l10n.t("Reordering is not available yet.") });
                        break;
                    }
                    reordering = true;
                    void reorderFromGraph(document, currentTree, message, () => !disposed).then(() => {
                        post({ type: "reorderResult", id: message.id });
                        void send();
                    }, (error: unknown) => {
                        post({ type: "reorderResult", id: message.id,
                            error: error instanceof Error ? error.message : String(error) });
                    }).finally(() => { reordering = false; });
                    break;
                case "reference": {
                    const revision = ++referenceRevision;
                    const active = () => !disposed && revision === referenceRevision && document.version === message.version;
                    const resolve = currentTree === undefined ? Promise.resolve(undefined)
                        : referenceFromGraph(document, currentTree, message, active);
                    // No popup for unavailable/ambiguous hover targets.
                    void resolve.catch(() => undefined).then(target => {
                        if (active()) post({ type: "referenceResult", id: message.id, version: message.version, target });
                    });
                    break;
                }
            }
        });
    }

    /** Put the text cursor on what was clicked in the graph. */
    private async reveal(
        document: vscode.TextDocument, start: number, end: number,
    ): Promise<void> {
        // 06 の 4.1: the offsets are UTF-16 code units, which is what
        // positionAt counts.
        const range = new vscode.Range(
            document.positionAt(start), document.positionAt(end));
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
        });
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    // 06 の 8.4: React Flow. One bundled script -- React, React Flow and
    // elkjs together, built by esbuild -- and its stylesheet. Styles need
    // 'unsafe-inline': React Flow positions its nodes by writing style
    // attributes, which is also how the layout's own sizes reach the boxes.
    private html(webview: vscode.Webview): string {
        const asset = (...parts: string[]) =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts));

        const script = asset("media", "rf", "bundle.js");
        const bundleCss = asset("media", "rf", "bundle.css");
        const sharedCss = asset("media", "graph.css");
        const nonce = String(Math.random()).slice(2);

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link href="${sharedCss}" rel="stylesheet">
<link href="${bundleCss}" rel="stylesheet">
<title>L^ graph</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
