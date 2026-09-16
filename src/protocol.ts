// L^ (lhat) -- what the extension host and the graph webview say to each
// other, and the shape lhatls answers lhat/ast with.
//
// 06 の 4.1 defines the reply; this file only restates it as types. The
// webview cannot speak LSP itself (it has no socket to lhatls and no language
// client), so the host asks on its behalf and forwards the answer -- 07 の L3.

/** One node of the syntax tree, as lhat/ast writes it (06 の 4.1). */
export interface AstNode {
    kind: string;
    /** UTF-16 code unit offsets into `AstReply.source`, half-open. */
    start: number;
    end: number;
    line: number;
    column: number;
    comments?: AstComment[];
    /**
     * Children, keyed by the union member they came from in ast.h. A member
     * holding a list is an array even when it holds one.
     */
    fields?: Record<string, AstNode | AstNode[]>;
}

export interface AstComment {
    start: number;
    end: number;
    block: boolean;
}

export interface AstReply {
    /** The whole unit. Every position above indexes into this. */
    source: string;
    root: AstNode;
}

export interface SourceSpan { start: number; end: number }
export interface ReferenceTarget extends SourceSpan {
    /** Import/require endpoints belong to the statement/expression box. */
    box?: boolean;
}

/** Host -> webview. */
export type ToWebview =
    | { type: "localization"; language: string; bundle?: Record<string, string> }
    | { type: "tree"; reply: AstReply; uri: string; version?: number }
    | { type: "renameResult"; id: string; error?: string }
    | { type: "referenceResult"; id: string; version: number; target?: ReferenceTarget }
    /** The unit is not part of any checked root yet (06 の 4.3). */
    | { type: "pending" }
    | { type: "error"; message: string }
    /** Bring what this span covers into view -- the outline was clicked. */
    | { type: "focus"; start: number; end: number };

/** Webview -> host. */
export type FromWebview =
    | { type: "ready" }
    /** Ask for the tree again -- after an edit, or after "pending". */
    | { type: "refresh" }
    | { type: "rename"; id: string; start: number; end: number; oldName: string; newName: string; version: number }
    | { type: "reference"; id: string; start: number; end: number; text: string; version: number }
    /** Put the text cursor on what was clicked in the graph. */
    | { type: "reveal"; start: number; end: number };
