// L^ (lhat) -- what the extension host and the graph webview say to each
// other, and the shape lhatls answers lhat/ast with.
//
// 06 の 4.1 defines the reply; this file only restates it as types. The
// webview cannot speak LSP itself (it has no socket to lhatls and no language
// client), so the host asks on its behalf and forwards the answer -- 07 の L3.

import type { StatementInsertion } from "./graphStatements";
import type { ListInsertion } from "./graphLists";

/** One node of the syntax tree, as lhat/ast writes it (06 の 4.1). */
export interface AstNode {
    kind: string;
    /** UTF-16 code unit offsets into `AstReply.source`, half-open. */
    start: number;
    end: number;
    line: number;
    column: number;
    comments?: AstComment[];
    /** Checker metadata, available in servers supporting graph type editing. */
    inferredType?: string;
    /** The settled answer type of a function literal. */
    inferredReturnType?: string;
    /** Resolved call signature; names/defaults come from its declaration, not the type. */
    callable?: CallableInfo;
    declared?: boolean;
    computed?: boolean;
    /**
     * Children, keyed by the union member they came from in ast.h. A member
     * holding a list is an array even when it holds one.
     */
    fields?: Record<string, AstNode | AstNode[]>;
}

export interface CallableInput { type: string; name?: string; default?: string }
export interface CallableInfo {
    inputs: CallableInput[];
    outputs: string[];
    variadic?: CallableInput;
    signature?: string;
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
export interface TypeSite extends SourceSpan {
    name: string;
    insert: number;
    annotation?: SourceSpan;
    colon?: number;
    /** The source token that carries the caption. It differs for `-> Type`. */
    anchor?: SourceSpan;
    /** `: Type` for bindings, ` -> Type` for a function result. */
    insertionPrefix?: string;
    /** The written `->`, removed together with an explicit return annotation. */
    operator?: SourceSpan;
    explicit: boolean;
    required: boolean;
    typeText: string;
    /** One position in a callable's multi-value answer. */
    result?: { index: number; owner: number; types: string[]; annotationEnd?: number };
}
export interface ReferenceTarget extends SourceSpan {
    /** Import/require endpoints belong to the statement/expression box. */
    box?: boolean;
}

/** Host -> webview. */
export type ToWebview =
    | { type: "localization"; language: string; bundle?: Record<string, string> }
    | { type: "tree"; reply: AstReply; uri: string; version?: number }
    | { type: "renameResult"; id: string; error?: string }
    | { type: "typeOptions"; id: string; candidates?: string[]; error?: string }
    | { type: "typeResult"; id: string; error?: string }
    | { type: "reorderResult"; id: string; error?: string }
    | { type: "statementResult"; id: string; error?: string }
    | { type: "svgResult"; id: string; error?: string }
    | { type: "toggleFold"; key: string; version: number }
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
    | { type: "saveSvg"; id: string; svg: string }
    | { type: "rename"; id: string; start: number; end: number; oldName: string; newName: string; version: number }
    | { type: "chooseType"; id: string; start: number; end: number; resultIndex?: number; version: number }
    | { type: "applyType"; id: string; typeText?: string }
    | { type: "removeType"; id: string; start: number; end: number; resultIndex?: number; version: number }
    | { type: "cancelType"; id: string }
    | { type: "insertStatement"; id: string; site: StatementInsertion; template: string; version: number }
    | { type: "insertElement"; id: string; site: ListInsertion; template: string; version: number }
    | { type: "replaceOperator"; id: string; start: number; end: number; operator: string; version: number }
    | { type: "toggleStatement"; id: string; start: number; end: number; version: number }
    | { type: "reorder"; id: string; sourceStart: number; sourceEnd: number; targetStart: number; targetEnd: number; before: boolean; version: number }
    | { type: "reference"; id: string; start: number; end: number; text: string; version: number }
    /** Put the text cursor on what was clicked in the graph. */
    | { type: "reveal"; start: number; end: number };
