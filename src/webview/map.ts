// L^ (lhat) -- the syntax tree, as lhat/ast answers with it, turned into an
// ELK graph. 06 の 5 章.
//
// Two axes and nothing else (5.1):
//   - the "voice" a node is read in decides the base direction --
//     statements run DOWN, expressions run RIGHT
//   - a branch's clauses TRANSPOSE that, and inside each clause the voice
//     goes back to what it was
// The voice changes in exactly two places: entering the expression a
// statement holds, and entering the body of a FUNC.
//
// Element lists (5.3.1) obey neither: they wrap into rows of a set width.

import type { AstNode, AstReply } from "../protocol.js";
import { literalOf, type LiteralValue } from "./literals";

const CH = 7.2; // mono advance at 12px
const LEAF_H = 30;
const MARKER_SIZE = 24;
const HEAD_H = 24; // a container's label strip
const PAD = 10;
const LAYER_GAP = 20;
const MAX_LABEL = 48;
// The fold button sits inside the box. A container has a label strip wide
// enough to spare, but a folded one is only as wide as its own label, so it
// is widened by this much to keep the two off each other.
const FOLD_BTN = 18;

// 5.3's table, by kind. Code switched off (01 の 6.5) lists statements the
// way a block does, and is laid out as one.
const STATEMENT_LIST = new Set(["block", "disabled"]);
// 04 の 4.5's try^{ } is here too: its items are if-clause nodes like an
// if^ statement's, the first being the body and the rest the catch arms. The
// body is not one of the alternatives, but it reads well enough at the left
// of them, and leaving try-block out of every table is what collapsed a
// whole try^{ } into a single leaf.
const BRANCH = new Set(["if-stmt", "if-expr", "try-block"]);
const ELEMENT_LIST = new Set([
    "table", "def", "self-table", "error-new", "errordef", "error-kind", "enumdef", "type-table",
]);
// These literal/definition lists reserve a trailing insertion affordance.
// It is not an execution step and does not belong to the source AST.
const ADDABLE = new Set(["table", "self-table", "def", "errordef", "enumdef"]);
const BODY_STATEMENT = new Set(["for", "repeat", "with"]);
const VOICE_TURN = new Set(["func"]);

// V6: types are not drawn -- they ride along in the label of whatever they
// annotate. V5: the same for declaration lists.
const NOT_DRAWN = new Set([
    "type-name", "type-func", "type-coro", "type-table", "type-tuple",
    "type-union", "type-intersect", "param", "member-decl",
]);

// These fields are consumed by their owning construct instead of generic
// expression expansion: binding names stay on the left, while statement
// conditions get their own foreground box. Definition names label the box.
const NOT_DRAWN_FIELDS: Record<string, string[]> = {
    define: ["targets"],
    reassign: ["targets"],
    "if-clause": ["condition"],
    errordef: ["name"],
    "error-kind": ["name"],
    enumdef: ["name"],
    "enum-member": ["name"],
};

// A qualified name is a MEMBER tree, a box per dot if it is drawn.
const ALWAYS_LEAF = new Set(["module", "import-stmt", "require-stmt"]);

// V15: collapsed when a view is first opened. A collapsed container is a
// fixed-size leaf, so neither its size nor the layout's cost depends on what
// is inside it.
const COLLAPSIBLE = new Set(["func", "def", "self-table", "errordef", "enumdef"]);
// Reassignments still fold whole; declarations split off their values below.
const FOLDS_WITH_VALUE = new Set(["reassign"]);

// 5.3.1 and 8.6: element lists that wrap. The rest of 5.3's element lists
// (def, errordef, self-table, ...) stack their basic elements vertically, so
// they never need a column count at all. How many columns a wrapping list
// gets is not a number any more (V9): it is however many fit the width.
const WRAPS = new Set(["table"]);

export interface ElkNode {
    id: string;
    labels?: { text: string }[];
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    children?: ElkNode[];
    edges?: ElkEdge[];
    layoutOptions?: Record<string, string>;
    ports?: {
        id: string; x: number; y: number;
        layoutOptions: Record<string, string>;
    }[];
    /** Not ELK's: what this node was made from, for clicks and folding. */
    lhat?: {
        kind: string; start: number; end: number;
        /** Whole literal leaves expose an editable display value. */
        literal?: LiteralValue;
        /** Member values are data, not executable statement rows. */
        noExecutionHandles?: boolean;
        collapsed?: boolean;
        /** Whether this one can be folded shut at all, open or not. */
        foldable?: boolean;
        /** Inside code switched off (01 の 6.5): drawn greyed out. */
        disabled?: boolean;
        /** An invisible layout row, or one of its two visible boxes. */
        definitionRole?: "row" | "declaration" | "value";
        /** Visible declaration used by execution edges attached to a row. */
        executionNode?: string;
        /** Sequential groups pass their execution lines through to these children. */
        executionEntry?: string;
        executionExit?: string;
        /** A parser-generated branch group with no additional visible box. */
        layoutOnly?: boolean;
        /** A source-backed condition/pattern box, not an execution step. */
        condition?: { entry?: string; inset: number; axis?: "horizontal" };
        /** A statement branch enters these statements from its top handle. */
        executionBranches?: string[];
        /** Shared horizontal fan-out lane below the top handle. */
        branchOffset?: number;
        /** Expression candidates merge at the box's left definition handle. */
        definitionBranches?: string[];
        definitionBranchOffset?: number;
        /** The sole result of an expression clause. */
        expressionValue?: string;
        /** A visual entry/insertion point, not a source-language node. */
        synthetic?: "start" | "add";
        /** A source-backed statement rendered as an icon rather than text. */
        pictogram?: "return";
        /** Source selection for the declaration excludes '=' and the value. */
        revealEnd?: number;
        definitionHandleY?: number;
        /** Wide outermost pair: its value is lowered and scrolls on its own. */
        stackedDefinition?: boolean;
    };
}

export interface ElkEdge {
    id: string;
    sources: string[];
    targets: string[];
    /** 6.3's device for ELK, kept out of the picture unless `drawn`. */
    pinned?: boolean;
    /** 8.6: an execution line -- consecutive statements, shown as an arrow. */
    drawn?: boolean;
    /** The value defines the declaration: drawn from right to left. */
    definition?: boolean;
    layoutOptions?: Record<string, string>;
    sections?: {
        startPoint: { x: number; y: number };
        endPoint: { x: number; y: number };
        bendPoints?: { x: number; y: number }[];
    }[];
}

interface Child {
    field: string;
    node: AstNode;
    inList: boolean;
}

function allChildren(node: AstNode): Child[] {
    const out: Child[] = [];
    for (const [field, value] of Object.entries(node.fields ?? {})) {
        if (Array.isArray(value)) {
            for (const c of value) out.push({ field, node: c, inList: true });
        } else {
            out.push({ field, node: value, inList: false });
        }
    }
    return out.sort((a, b) => a.node.start - b.node.start);
}

function drawnChildren(node: AstNode): Child[] {
    if (ALWAYS_LEAF.has(node.kind)) return [];
    const skip = NOT_DRAWN_FIELDS[node.kind] ?? [];
    return allChildren(node).filter((c) => !skip.includes(c.field) &&
        (!NOT_DRAWN.has(c.node.kind) ||
            // Error payloads are the contents being inspected, not a
            // function signature. Both AST spellings retain their defaults.
            (node.kind === "error-kind" && c.field === "members" &&
                (c.node.kind === "param" || c.node.kind === "member-decl"))));
}

// Introduction sites and returns share the same pair of boxes.
// PARAM is built only for visible error payload fields; function signatures
// still stay in labels.
const DEFINITION_FIELDS: Record<string, [string[], string[]]> = {
    define: [["targets"], ["values"]], // let^ and var^ use the same AST kind
    return: [[], ["value"]], // the return pictogram takes the declaration's place
    "table-entry": [["key", "type"], ["value"]],
    "enum-member": [["name"], ["members"]],
    param: [["name", "type"], ["fallback"]],
    "member-decl": [["key", "name", "type"], ["fallback", "value"]],
};

// The parser also wraps an expression-only function body in RETURN. It uses
// the same visible return/value pair, even when return^ was omitted in text.
function definitionParts(node: AstNode): { targets: Child[]; values: Child[] } | undefined {
    const parts = DEFINITION_FIELDS[node.kind];
    if (parts === undefined) return undefined;
    const children = allChildren(node);
    const targets = children.filter((c) => parts[0].includes(c.field));
    const values = children.filter((c) => parts[1].includes(c.field) && !NOT_DRAWN.has(c.node.kind));
    // Positional table entries, implicit enum members, and abstract/typed-only
    // fields have no definition line. A written type is never an initializer.
    return (targets.length > 0 || node.kind === "return") && values.length > 0
        ? { targets, values } : undefined;
}

// 5.2: preserve the path to a branch, body, or member definition. Otherwise
// a branch-free enclosing expression would swallow its members' '=' lines.
function holdsExpandedChild(node: AstNode): boolean {
    for (const { node: c } of drawnChildren(node)) {
        if (BRANCH.has(c.kind) || VOICE_TURN.has(c.kind) || ADDABLE.has(c.kind) ||
            c.kind === "return" ||
            definitionParts(c) !== undefined || holdsExpandedChild(c)) {
            return true;
        }
    }
    return false;
}

function holdsCollapsible(node: AstNode): boolean {
    return drawnChildren(node).some(
        ({ node: c }) => COLLAPSIBLE.has(c.kind) || holdsCollapsible(c));
}

// 01 の 6.5: everything drawn inside code switched off is switched off too.
function markDisabled(node: ElkNode): void {
    if (node.lhat !== undefined) node.lhat.disabled = true;
    for (const edge of node.edges ?? []) {
        if (!edge.definition) edge.drawn = false;
    }
    for (const child of node.children ?? []) markDisabled(child);
}

// V16: the construct's own text with every drawn child's span cut out, so a
// container shows what shapes it rather than everything below it. What is not
// drawn stays, which is how names and conditions reach the label.
function labelOf(node: AstNode, source: string, drawn: Child[]): string {
    // Named definitions label their containers; the member/field lists are
    // children, not text to spill into a folded title or breadcrumb.
    const name = node.fields?.name;
    if ((node.kind === "errordef" || node.kind === "error-kind" || node.kind === "enumdef") &&
        name !== undefined && !Array.isArray(name)) {
        const title = source.slice(node.start, name.end).replace(/\s+/g, " ").trim();
        return title.length > MAX_LABEL ? title.slice(0, MAX_LABEL - 1) + "…" : title;
    }
    const holes = drawn
        .map((c) => [c.node.start, c.node.end] as const)
        .sort((a, b) => a[0] - b[0]);
    let text = "";
    let cursor = node.start;
    for (const [start, end] of holes) {
        if (start > cursor) text += source.slice(cursor, start);
        if (end > cursor) {
            if (start > cursor || text !== "") text += "…";
            cursor = end;
        }
    }
    if (cursor < node.end) text += source.slice(cursor, node.end);

    text = text.replace(/\s+/g, " ").replace(/(…\s*)+/g, "… ").trim();
    if (text === "") text = node.kind;
    return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + "…" : text;
}

// 06 の 8.2: a named subroutine is a unit of its own, so opening one means
// going into it rather than unfolding it where it stands. Anonymous ones are
// only meaningful where they were written, so they stay put.
export function isDrillTarget(node: AstNode): boolean {
    if (!COLLAPSIBLE.has(node.kind)) return false;
    return node.kind === "func" ? false : true;
}

/** The node a view is rooted at, found by the position it starts at. */
export function nodeAt(root: AstNode, start: number): AstNode | undefined {
    if (root.start === start) return root;
    for (const { node: c } of allChildren(root)) {
        if (start < c.start || start >= c.end) continue;
        const found = nodeAt(c, start);
        if (found !== undefined) return found;
    }
    return undefined;
}

/** What a definition is called, for the trail of where a view came from. */
export function titleOf(node: AstNode, source: string): string {
    return labelOf(node, source, drawnChildren(node)).replace(/\s*…\s*$/, "");
}

export interface MapOptions {
    /** V15: fold definitions when the view opens. */
    collapse?: boolean;
    /**
     * What the reader has folded or unfolded by hand, keyed by start
     * position. An entry decides that one node; everything without one
     * follows `collapse`. Positions rather than nodes, for the reason 8.2's
     * trail uses them: the tree is replaced whole on every edit.
     */
    folds?: Record<number, boolean>;
    /**
     * 8.2: the node this view is rooted at. Its own box is not drawn -- the
     * view *is* that definition -- so what shows is the body alone.
     */
    root?: AstNode;
    /**
     * 8.6: the font factor, 1 at the default size. Zoom is not a transform
     * of the picture but a re-layout at another type size, so every metric
     * here scales by it and the text follows through a CSS variable.
     */
    scale?: number;
    /**
     * 8.6: the width the view has, in pixels at the current scale. It is a
     * ceiling, not a stretch: only wrapping element lists consult it. Absent
     * means unconstrained (the old behaviour).
     */
    width?: number;
}

/** Split declaration rows read from the left when the whole view is wide. */
export function graphViewportX(laid: ElkNode, width: number): number {
    const centered = (width - (laid.width ?? 0)) / 2;
    return laid.lhat?.definitionRole === "row" ||
        laid.children?.some((n) => n.lhat?.definitionRole === "row")
        ? Math.max(8, centered) : centered;
}

/**
 * Reserve a declaration-height lane above a wide, outermost definition.
 * This runs once on each fresh ELK result, after widths are known. Only the
 * value moves inside the row; its descendants retain ELK's relative layout.
 * Later statements and the document's scroll extent gain the same height.
 * Renderers use node/handle positions, not the original ELK edge sections.
 */
export function stackWideDefinitions(laid: ElkNode, usableWidth: number): ElkNode {
    // Width alone misses rows displaced by the shared declaration column.
    // Compare the value's actual right edge with the viewport's right margin,
    // in graph coordinates, just as the scroll bounds in toFlow do.
    const rightEdge = usableWidth + 8 - graphViewportX(laid, usableWidth + 16);
    const stack = (row: ElkNode, rowX: number): ElkNode => {
        if (row.lhat?.definitionRole !== "row" || usableWidth <= 0) return row;
        const declaration = row.children?.find((n) => n.lhat?.definitionRole === "declaration");
        const value = row.children?.find((n) => n.lhat?.definitionRole === "value");
        if (declaration === undefined || value === undefined) return row;
        if (rowX + (value.x ?? 0) + (value.width ?? 0) <= rightEdge) return row;
        const offset = declaration.height ?? 0;
        return {
            ...row,
            height: (row.height ?? 0) + offset,
            lhat: { ...row.lhat, stackedDefinition: true },
            children: row.children?.map((n) => n === value
                ? { ...n, y: (n.y ?? 0) + offset } : n),
            ports: row.ports?.map((p) => p.layoutOptions["elk.port.side"] === "SOUTH"
                ? { ...p, y: p.y + offset } : p),
        };
    };
    if (laid.lhat?.definitionRole === "row") return stack(laid, 0);
    let extraHeight = 0;
    const children = laid.children?.map((node) => {
        const next = stack(node, node.x ?? 0);
        const y = (node.y ?? 0) + extraHeight;
        extraHeight += (next.height ?? 0) - (node.height ?? 0);
        return next === node && y === node.y ? node : { ...next, y };
    });
    return extraHeight === 0 ? laid
        : { ...laid, children, height: (laid.height ?? 0) + extraHeight };
}

export function toElk(reply: AstReply, options: MapOptions = {}): ElkNode {
    const source = reply.source;
    // Only executable scopes get an entry point. A function's body starts a
    // new chain; its declaration is never connected to the code inside it.
    const entryScopes = new Set<AstNode>();
    const statementClauses = new Set<AstNode>();
    const expressionClauses = new Set<AstNode>();
    const matchStatements = new Set<AstNode>();
    const matchExpressions = new Set<AstNode>();
    const matchBodies = new Set<AstNode>();
    const viewRoot = options.root ?? reply.root;
    if (viewRoot.kind === "block") entryScopes.add(viewRoot);
    const findEntries = (node: AstNode): void => {
        const body = node.fields?.body;
        if (node.kind === "func" && body !== undefined && !Array.isArray(body)) {
            entryScopes.add(body);
        }
        // The parser lowers for^ subject { when^ ... } to FOR -> IF_STMT.
        // Its body starts at '{'; for^ ... if^ has a written 'if^' instead.
        // Keep the focus evaluation, but not a second box for this lowered IF.
        if (node.kind === "for" && body !== undefined && !Array.isArray(body) &&
            body.kind === "if-stmt" && source[body.start] === "{") {
            matchStatements.add(node);
            matchBodies.add(body);
        }
        if (node.kind === "for" && body !== undefined && !Array.isArray(body) &&
            body.kind === "if-expr" && source[body.start] === ":") {
            matchExpressions.add(node);
            matchBodies.add(body);
        }
        if (node.kind === "if-stmt" || node.kind === "if-expr") {
            for (const { node: child } of drawnChildren(node)) {
                if (child.kind === "if-clause") {
                    (node.kind === "if-stmt" ? statementClauses : expressionClauses).add(child);
                }
            }
        }
        for (const { node: child } of allChildren(node)) findEntries(child);
    };
    findEntries(viewRoot);
    let counter = 0;
    const nextId = (kind: string) => `${kind}-${counter++}`;

    // 8.6: zoom is a re-layout at another type size, so every metric scales.
    const S = options.scale ?? 1;
    const px = (v: number) => Math.round(v * S);
    const widthFor = (label: string) =>
        Math.max(px(56), Math.round(label.length * CH * S) + px(18));

    const from = (
        node: AstNode,
        extra: { collapsed?: boolean; foldable?: boolean } = {},
    ) => ({
        kind: node.kind, start: node.start, end: node.end, ...extra,
    });

    const leaf = (node: AstNode, label: string): ElkNode => {
        const literal = literalOf(node, source);
        const lines = literal?.value.split("\n") ?? [];
        const longest = lines.reduce((length, line) => Math.max(length, line.length), 0);
        return {
            id: nextId(node.kind),
            labels: [{ text: label }],
            width: literal === undefined ? widthFor(label)
                : widthFor(" ".repeat(Math.min(MAX_LABEL, longest) + (literal.kind === "string" ? 2 : 0))),
            height: px(LEAF_H + (literal?.kind === "string" ? Math.min(3, lines.length - 1) * 16 : 0)),
            lhat: { ...from(node), ...(literal === undefined ? {} : { literal }) },
        };
    };

    const memberHandles = (node: ElkNode): void => {
        if (node.lhat !== undefined) node.lhat.noExecutionHandles = true;
        // A callable is data here, but its body opens a new execution scope.
        if (node.lhat?.kind !== "func") {
            for (const child of node.children ?? []) memberHandles(child);
        }
    };

    const markerNode = (scope: AstNode, kind: "start" | "add"): ElkNode => ({
        id: nextId(kind),
        labels: [],
        width: px(MARKER_SIZE), height: px(MARKER_SIZE),
        lhat: { kind, start: scope.start, end: scope.start, synthetic: kind },
    });

    // Implicit returns have no keyword span to select: reveal the whole
    // expression, not an invented seven-character return^ token.
    const returnRevealEnd = (node: AstNode) => source.startsWith("return^", node.start)
        ? Math.min(node.end, node.start + "return^".length) : node.end;

    // Unlike synthetic start/add markers, explicit and implicit returns both
    // correspond to real source. Their value remains a separate edit target.
    const returnNode = (node: AstNode): ElkNode => ({
        id: nextId("return"), labels: [],
        width: px(MARKER_SIZE), height: px(MARKER_SIZE),
        lhat: { ...from(node), pictogram: "return",
            revealEnd: returnRevealEnd(node) },
    });

    const executionPort = (node: ElkNode, end: "in" | "out") =>
        node.lhat?.kind === "define-row" || node.lhat?.kind === "return-row"
            ? `${node.id}__flow-${end}` : node.id;

    // A branch enters a statement, not an intervening block/with box or
    // disabled placeholder. Stop at nested IFs, declarations and callables.
    const firstStatement = (node: ElkNode): ElkNode | undefined => {
        if (node.lhat?.disabled || node.lhat?.condition) return undefined;
        if (["block", "with", "if-clause", "disabled"].includes(node.lhat?.kind ?? "")) {
            for (const child of node.children ?? []) {
                const first = firstStatement(child);
                if (first !== undefined) return first;
            }
            return undefined;
        }
        return node;
    };

    const chain = (id: string, kids: ElkNode[]): ElkEdge[] =>
        kids.slice(1).map((k, i) => ({
            id: `${id}__ord${i}`,
            sources: [executionPort(kids[i], "out")],
            targets: [executionPort(k, "in")],
            pinned: true,
        }));

    // 8.6: a statement sequence's execution lines. Code switched off (01 の
    // 6.5) keeps its place and its order-pinning edges, but no line enters or
    // leaves it: the line runs from the statement before it straight to the
    // one after. That line stays out of the layout -- spanning two layers, it
    // would have ELK route around the skipped box and push it aside.
    const flow = (id: string, kids: ElkNode[]): ElkEdge[] => {
        const off = (k: ElkNode) => k.lhat?.disabled === true;
        const edges = chain(id, kids).map((e, i) =>
            off(kids[i]) || off(kids[i + 1]) ? e : { ...e, drawn: true });
        let live: ElkNode | undefined;
        kids.forEach((k, i) => {
            if (off(k)) return;
            if (live !== undefined && off(kids[i - 1])) {
                edges.push({
                    id: `${id}__skip${i}`,
                    sources: [executionPort(live, "out")],
                    targets: [executionPort(k, "in")],
                    drawn: true,
                    layoutOptions: { "elk.noLayout": "true" },
                });
            }
            live = k;
        });
        return edges;
    };

    const container = (
        id: string, label: string, dir: string, children: ElkNode[],
        edges: ElkEdge[], node: AstNode, padded = true,
    ): ElkNode => ({
        id,
        labels: [{ text: label }],
        layoutOptions: {
            "elk.algorithm": "layered",
            // 6.2: never inherited, so always written.
            "elk.direction": dir,
            "elk.padding": padded
                ? `[top=${px(HEAD_H + PAD)},left=${px(PAD)},` +
                  `bottom=${px(PAD)},right=${px(PAD)}]`
                : "[top=0,left=0,bottom=0,right=0]",
            "elk.spacing.nodeNode": `${px(14)}`,
            "elk.layered.spacing.nodeNodeBetweenLayers": `${px(LAYER_GAP)}`,
            // Children alone do not determine a box's width: its title
            // must fit too. Invisible layout groups need no header space.
            ...(padded && label !== "" ? {
                "elk.nodeSize.constraints": "MINIMUM_SIZE",
                "elk.nodeSize.minimum": `(${widthFor(label)}, 0)`,
            } : {}),
        },
        children,
        edges,
        lhat: from(node),
    });

    // 6.4: a list wraps into rows built here. rectpacking loses source order
    // once the elements differ in size, which an element list does.
    //
    // 8.6 (V9 settled): a row takes as many elements as the width holds --
    // the view's width is a ceiling for wrapping, nothing else. An element
    // wider than the whole width gets a row of its own.
    function fittedRows(id: string, kids: ElkNode[], avail: number): ElkNode[] {
        const gap = px(12);
        const slices: ElkNode[][] = [];
        let row: ElkNode[] = [];
        let used = 0;
        for (const kid of kids) {
            // A container whose width ELK has not measured yet gets its own
            // row. Treating it as zero packs arbitrarily wide definitions.
            if (kid.width === undefined) {
                if (row.length > 0) slices.push(row);
                slices.push([kid]);
                row = [];
                used = 0;
                continue;
            }
            const w = kid.width;
            if (row.length > 0 && used + gap + w > avail) {
                slices.push(row);
                row = [];
                used = 0;
            }
            row.push(kid);
            used += (row.length > 1 ? gap : 0) + w;
        }
        if (row.length > 0) slices.push(row);
        return slices.map((slice, i) => {
            const rid = `${id}__r${i}`;
            // No source metadata: this is only an ELK row, not a visible
            // graph box. The renderer retains it solely as a layout parent.
            return {
                id: rid,
                layoutOptions: {
                    "elk.algorithm": "layered",
                    "elk.direction": "RIGHT",
                    "elk.padding": "[top=0,left=0,bottom=0,right=0]",
                    "elk.spacing.nodeNode": `${gap}`,
                    "elk.layered.spacing.nodeNodeBetweenLayers": `${gap}`,
                },
                children: slice,
                edges: chain(rid, slice),
            };
        });
    }

    // `unfold` marks the way down to the body of the definition this view was
    // opened at (8.2). Going into a definition is what opens it, so neither it
    // nor its body is folded again -- but a definition *inside* that body is,
    // since that one is a way further in rather than part of what is shown.
    function build(node: AstNode, voice: "stmt" | "expr",
                   unfold: boolean, avail: number): ElkNode {
        // A keyless entry is just its value, not another visible wrapper.
        // In particular, a def^ field template must expose its own members.
        const positional = node.fields?.value;
        if (node.kind === "table-entry" && node.fields?.key === undefined &&
            positional !== undefined && !Array.isArray(positional) &&
            positional.start === node.start && positional.end === node.end) {
            return build(positional, voice, unfold, avail);
        }

        // The declaration/key remains visible while its value folds alone.
        // This exception to 5.2 also splits simple initializers such as '= 1'.
        const parts = definitionParts(node);
        const isReturn = node.kind === "return";
        if (isReturn && parts === undefined) return returnNode(node);
        if (parts !== undefined) {
            const { targets, values } = parts;
            const rowKind = isReturn ? "return-row"
                : node.kind === "define" ? "define-row" : "member-row";
            const id = nextId(rowKind);
            let declarationEnd = isReturn ? returnRevealEnd(node)
                : Math.max(...targets.map((c) => c.node.end));
            // A computed key's AST span can omit its closing ')' and ']'.
            // Keep those on the left, but not '=' or parentheses of the RHS.
            // Comments between tokens must not be mistaken for punctuation.
            for (let i = declarationEnd; !isReturn && i < values[0].node.start;) {
                if (/\s/.test(source[i])) { i++; continue; }
                if (source.startsWith("#[", i)) {
                    let depth = 1;
                    i += 2;
                    while (i < values[0].node.start && depth > 0) {
                        if (source.startsWith("#[", i)) { depth++; i += 2; }
                        else if (source.startsWith("]#", i)) { depth--; i += 2; }
                        else i++;
                    }
                    continue;
                }
                if (source[i] === "#") {
                    while (i < values[0].node.start && source[i] !== "\n") i++;
                    continue;
                }
                if (source[i] !== "]" && source[i] !== ")") break;
                declarationEnd = ++i;
            }
            const label = labelOf({ ...node, end: declarationEnd }, source, []);
            const declaration = isReturn ? returnNode(node) : leaf(node, label);
            const handleY = (declaration.height ?? px(LEAF_H)) / 2;
            declaration.lhat = {
                ...declaration.lhat!, definitionRole: "declaration", revealEnd: declarationEnd,
                definitionHandleY: handleY,
            };
            const gap = px(28);
            const valueAvail = avail - (declaration.width ?? 0) - gap;
            const value = values.length === 1
                ? build(values[0].node, "expr", unfold, valueAvail)
                : container(nextId("definition-value"), "", "RIGHT",
                    values.map((c) => build(c.node, "expr", unfold, valueAvail)), [], {
                        ...node, kind: "definition-value",
                        start: values[0].node.start, end: values[values.length - 1].node.end,
                    });
            if (values.length > 1) value.edges = chain(value.id, value.children ?? []);
            value.lhat = {
                ...value.lhat!, definitionRole: "value", definitionHandleY: handleY,
            };
            const attach = (box: ElkNode, side: "EAST" | "WEST", suffix: string) => {
                box.layoutOptions = { ...box.layoutOptions, "elk.portConstraints": "FIXED_POS" };
                box.ports = [{
                    id: `${box.id}__${suffix}`,
                    x: side === "EAST" ? box.width ?? 0 : 0,
                    y: handleY,
                    layoutOptions: { "elk.port.side": side },
                }];
            };
            attach(declaration, "EAST", "definition-in");
            attach(value, "WEST", "definition-out");
            // LEFT applies to the definition arrow only. The value's own
            // expression layout remains RIGHT, with branches transposed DOWN.
            const row = container(id, "", "LEFT", [declaration, value], [{
                id: `${id}__definition`,
                sources: [`${value.id}__definition-out`],
                targets: [`${declaration.id}__definition-in`],
                drawn: true, definition: true,
            }], node, false);
            row.lhat = {
                ...from(node), kind: rowKind, definitionRole: "row",
                executionNode: declaration.id,
            };
            // Wrapping tables can measure simple pairs without asking ELK;
            // complex values remain unknown and receive a row of their own.
            if (value.width !== undefined) {
                row.width = (declaration.width ?? 0) + gap + value.width;
            }
            row.layoutOptions!["elk.layered.spacing.nodeNodeBetweenLayers"] = `${gap}`;
            // The surrounding statement sequence aligns at the declaration,
            // even when the values have very different widths and heights.
            // Members have no execution axis. Giving them north/south ports
            // would force horizontally wrapping pairs into a staircase.
            if (node.kind === "define" || isReturn) {
                row.layoutOptions!["elk.portConstraints"] = "FIXED_POS";
                row.ports = ["in", "out"].map((end) => ({
                    id: `${id}__flow-${end}`, x: (declaration.width ?? 0) / 2, y: 0,
                    layoutOptions: { "elk.port.side": end === "in" ? "NORTH" : "SOUTH" },
                }));
            }
            return row;
        }
        // Nothing with an empty body is worth a fold, so the emptiness is
        // asked about before anything else -- an f^() {} folded shut would
        // read '… …'.
        const foldable =
            (COLLAPSIBLE.has(node.kind) ||
                (FOLDS_WITH_VALUE.has(node.kind) && holdsCollapsible(node))) &&
            drawnChildren(node).length > 0;

        // A manual fold outweighs the default, but never folds the root we
        // just entered: that view must show its body even if it was entered
        // from a box the reader explicitly folded shut.
        if (foldable && !unfold &&
            (options.folds?.[node.start] ?? options.collapse === true)) {
            const text = labelOf(node, source, drawnChildren(node)) + " …";
            return {
                id: nextId(node.kind),
                labels: [{ text }],
                // Room for the fold button, which sits inside the box.
                width: widthFor(text) + px(FOLD_BTN),
                height: px(LEAF_H + 8),
                lhat: from(node, { collapsed: true, foldable: true }),
            };
        }

        const built = expand(node, voice, unfold, avail);
        // Said of an open one too: the button is how it gets shut again.
        if (foldable && built.lhat !== undefined) {
            built.lhat.foldable = true;
            if (built.children?.length && built.layoutOptions !== undefined) {
                const headerWidth = widthFor(built.labels?.[0]?.text ?? "") + px(FOLD_BTN);
                built.layoutOptions["elk.nodeSize.minimum"] = `(${headerWidth}, 0)`;
            }
        }
        if (node.kind === "disabled") markDisabled(built);
        return built;
    }

    function expand(node: AstNode, voice: "stmt" | "expr",
                    unfold: boolean, avail: number): ElkNode {
        // What is left for this node's own children, one padding in.
        const inner_avail = avail - 2 * px(PAD);
        const kind = node.kind;
        const kids = drawnChildren(node);
        const expressionClause = expressionClauses.has(node);
        const clause = statementClauses.has(node) || expressionClause;
        const condition = node.fields?.condition;
        const label = matchBodies.has(node) || clause ? ""
            : labelOf(node, source, kids);

        if (kids.length === 0 && !entryScopes.has(node) && !ADDABLE.has(kind) && !clause) return leaf(node, label);

        // 5.2, statements included. The label is taken again with nothing cut
        // out: a leaf draws none of its children, so there are no holes to
        // leave. Cutting them here emptied the label of anything whose one
        // child covers the whole of it -- 'print(x)' read as "call-stmt".
        if (!clause && !STATEMENT_LIST.has(kind) && !BRANCH.has(kind) &&
            !ELEMENT_LIST.has(kind) && !VOICE_TURN.has(kind) &&
            !BODY_STATEMENT.has(kind) && !holdsExpandedChild(node)) {
            return leaf(node, labelOf(node, source, []));
        }

        // Past a subroutine or definition, the way down has been walked: what
        // lies below is another way in rather than more of this view.
        const childUnfold = unfold && !COLLAPSIBLE.has(kind);

        const id = nextId(kind);

        if (expressionClause) {
            // Expressions transpose the statement policy: alternatives go
            // down, with condition/value pairs across each arm. The value is
            // a separate source-backed expression, never a return statement.
            const predicate = condition !== undefined && !Array.isArray(condition)
                ? leaf(condition, labelOf(condition, source, [])) : undefined;
            const body = kids.find((c) => c.field === "body");
            const value = body === undefined ? undefined
                : build(body.node, "expr", childUnfold, inner_avail);
            if (value !== undefined) {
                value.lhat = { ...value.lhat!, definitionRole: "value",
                    definitionHandleY: px(LEAF_H / 2) };
            }
            if (predicate !== undefined) {
                predicate.lhat!.condition = { entry: value?.id, inset: px(PAD), axis: "horizontal" };
            }
            const children = [predicate, value].filter((n): n is ElkNode => n !== undefined);
            const built = container(id, "", "RIGHT", children, chain(id, children), node);
            built.lhat!.expressionValue = value?.id;
            const left = predicate === undefined ? px(PAD + LAYER_GAP) + widthFor("") : px(PAD);
            built.layoutOptions!["elk.padding"] =
                `[top=${px(PAD)},left=${left},bottom=${px(PAD)},right=${px(PAD)}]`;
            if (children.length === 0) {
                built.width = left + px(PAD);
                built.height = px(LEAF_H + 2 * PAD);
            }
            return built;
        }

        if (clause) {
            // The condition is an independent, opaque foreground box. It
            // orders the layout but is not an execution endpoint: the branch
            // still connects directly to the first real statement behind it.
            const predicate = condition !== undefined && !Array.isArray(condition)
                ? leaf(condition, labelOf(condition, source, [])) : undefined;
            const body = kids.find((c) => c.field === "body");
            const contents = body === undefined ? undefined
                : build(body.node, "stmt", childUnfold, avail);
            const statements = body?.node.kind === "block"
                ? contents?.children ?? [] : contents === undefined ? [] : [contents];
            if (predicate !== undefined) {
                predicate.lhat!.condition = {
                    entry: statements.map(firstStatement).find((n) => n !== undefined)?.id,
                    inset: px(PAD),
                };
            }
            const edges = body?.node.kind === "block" ? contents?.edges ?? [] : [];
            const children = predicate === undefined ? statements : [predicate, ...statements];
            const built = container(id, "", "DOWN", children,
                predicate !== undefined && statements.length > 0
                    ? [...chain(id, [predicate, statements[0]]), ...edges] : edges, node);
            // Reserve the same lane for unconditional arms without inventing
            // an empty condition node. Only the immediate body is hoisted.
            const top = predicate === undefined ? PAD + LEAF_H + LAYER_GAP : PAD;
            built.layoutOptions!["elk.padding"] =
                `[top=${px(top)},left=${px(PAD)},bottom=${px(PAD)},right=${px(PAD)}]`;
            if (children.length === 0) {
                built.width = widthFor("");
                built.height = px(top + PAD);
            }
            return built;
        }

        // f^/p^ already provide the body box. Hoist only their immediate
        // BLOCK's contents and edges, preserving nested scopes. Pass the
        // same width: this replaces, not wraps, its padding.
        const body = kids.find((c) => c.field === "body" && c.node.kind === "block");
        if (kind === "func" && body !== undefined) {
            const contents = build(body.node, "stmt", childUnfold, avail);
            return container(id, label, "DOWN", contents.children ?? [], contents.edges ?? [], node);
        }

        // 5.3.1: an element list wraps, and does not follow the voice.
        if (ELEMENT_LIST.has(kind)) {
            const items = kids.map(
                (c) => build(c.node, "expr", childUnfold, inner_avail));
            items.forEach(memberHandles);
            const content = WRAPS.has(kind) && items.length > 1
                ? fittedRows(id, items, inner_avail) : items;
            // Keep the insertion control below the whole final row, even
            // for wrapping tables or empty lists. Ordering edges stay hidden.
            if (ADDABLE.has(kind)) content.push(markerNode(node, "add"));
            return container(id, label, "DOWN", content, chain(id, content), node);
        }

        // A branch transposes; each clause goes back to the enclosing voice.
        if (BRANCH.has(kind)) {
            const clauses = kids.map(
                (c) => build(c.node, kind === "if-expr" ? "expr" : voice, childUnfold, inner_avail));
            const dir = kind === "if-expr" || voice === "expr" ? "DOWN" : "RIGHT";
            // 6.3: clauses carry no edge of their own, so ELK would pack them
            // by area and lose both the axis and the source order.
            const built = container(id, label, dir, clauses, chain(id, clauses), node);
            if (kind === "if-stmt") {
                // These are display edges, not ELK constraints: an edge from
                // an ancestor to its descendants would change the layout.
                built.lhat!.executionBranches = clauses.flatMap((c) => {
                    const first = firstStatement(c);
                    return first === undefined ? [] : [first.id];
                });
                built.lhat!.branchOffset = px(18);
                if (matchBodies.has(node)) built.lhat!.layoutOnly = true;
            }
            if (kind === "if-expr") {
                built.lhat!.definitionBranches = clauses.flatMap((c) =>
                    c.lhat?.expressionValue === undefined ? [] : [c.lhat.expressionValue]);
                built.lhat!.definitionBranchOffset = px(18);
                built.lhat!.definitionHandleY = px(LEAF_H / 2);
                if (matchBodies.has(node)) built.lhat!.layoutOnly = true;
            }
            return built;
        }

        const inner: ElkNode[] = [];
        if (entryScopes.has(node)) inner.push(markerNode(node, "start"));
        for (const { field, node: c } of kids) {
            let childVoice = voice;
            if (voice === "stmt" && !STATEMENT_LIST.has(kind) &&
                !["body", "items", "extra"].includes(field)) {
                childVoice = "expr"; // a statement's expression
            }
            if (VOICE_TURN.has(kind) && field === "body") childVoice = "stmt";
            if (BODY_STATEMENT.has(kind) && field === "body") childVoice = "stmt";
            if (matchExpressions.has(node) && field === "body") childVoice = "expr";
            if (kind === "if-clause" && field === "body") childVoice = voice;
            inner.push(build(c, childVoice, childUnfold, inner_avail));
        }

        // V4: 9 章's clauses are `extra` on a BLOCK and run in a fixed order,
        // so they go down with the rest of the statements.
        const dir = voice === "stmt" || matchExpressions.has(node) ? "DOWN" : "RIGHT";
        // A with^ is a sequence of resource declarations followed by its
        // body (items/extra in the AST). A match evaluates its focus before
        // dispatching. Connect these steps, not just their outer borders.
        // Expressions, branch alternatives, and member lists stay unlinked.
        const match = matchStatements.has(node);
        const sequential = voice === "stmt" && (kind === "block" || kind === "with" || match);
        const built = container(id, label, dir, inner,
            sequential ? flow(id, inner) : chain(id, inner), node);
        if (matchExpressions.has(node)) {
            const body = inner.find((c) => c.lhat?.definitionBranches !== undefined);
            built.lhat!.definitionBranches = body === undefined ? [] : [body.id];
            built.lhat!.definitionBranchOffset = px(18);
            built.lhat!.definitionHandleY = px(LEAF_H / 2);
            // Keep the outer merge lane left of the subject and inner match,
            // so both ends of the connecting trunk can remain horizontal.
            built.layoutOptions!["elk.padding"] =
                `[top=${px(HEAD_H + PAD)},left=${px(HEAD_H + PAD)},bottom=${px(PAD)},right=${px(PAD)}]`;
        }
        const live = inner.filter((child) => !child.lhat?.disabled);
        if (match) {
            // Enter at FOR's top handle, evaluate its focus, then fan out at
            // the unboxed IF junction. An explicit let^/var^ focus keeps its
            // definition line and is evaluated once, not once per arm.
            const first = live.map(firstStatement).find((n) => n !== undefined);
            built.lhat!.executionBranches = first === undefined ? [] : [first.id];
            built.lhat!.branchOffset = px(18);
        } else if (sequential && live.length > 0) {
            built.lhat!.executionEntry = live[0].id;
            built.lhat!.executionExit = live[live.length - 1].id;
        }
        return built;
    }

    const width = options.width ?? Number.POSITIVE_INFINITY;
    const root = build(viewRoot, "stmt",
                       options.root !== undefined, width - 2 * px(PAD));
    // A leaf needs a wrapper. A branch view retains its outer box: its top
    // handle is the branch origin and must not disappear with the view root.
    if (!root.children?.length || root.lhat?.executionBranches !== undefined ||
        root.lhat?.definitionBranches !== undefined) {
        return {
            id: "view",
            layoutOptions: {
                "elk.algorithm": "layered",
                "elk.direction": "DOWN",
                "elk.padding": `[top=${px(PAD)},left=${px(PAD)},` +
                    `bottom=${px(PAD)},right=${px(PAD)}]`,
                "elk.spacing.nodeNode": `${px(14)}`,
            },
            children: [root],
            edges: [],
        };
    }
    root.layoutOptions = {
        ...root.layoutOptions,
        "elk.padding": `[top=${PAD},left=${PAD},bottom=${PAD},right=${PAD}]`,
    };
    root.labels = [];
    // The view's root has no visible box/title; only its children are drawn.
    delete root.layoutOptions["elk.nodeSize.minimum"];
    delete root.layoutOptions["elk.nodeSize.constraints"];
    return root;
}
