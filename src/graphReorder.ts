import type { AstNode, AstReply } from "./protocol";
import { commaLists } from "./graphLists";

/** A source-backed item whose place among siblings can be changed. */
export interface ReorderSite {
    /** Statements have a vertical insertion line; table members use their nearest edge. */
    kind: "statement" | "element";
    /** Identity of the AST sibling list, stable for this source version. */
    list: string;
    start: number;
    end: number;
}

export interface ReorderRequest {
    sourceStart: number;
    sourceEnd: number;
    targetStart: number;
    targetEnd: number;
    before: boolean;
}

export interface SourceEdit {
    start: number;
    end: number;
    text: string;
}

const ELEMENT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["table", new Set(["items"])],
    ["def", new Set(["items"])],
    ["self-table", new Set(["items"])],
    ["error-new", new Set(["items", "members"])],
    ["errordef", new Set(["members"])],
    ["error-kind", new Set(["members"])],
    ["enumdef", new Set(["members"])],
    ["type-table", new Set(["items", "members"])],
]);

interface ReorderGroup {
    site: Omit<ReorderSite, "start" | "end">;
    items: AstNode[];
}

const listKey = (kind: ReorderSite["kind"], parent: AstNode, field: string) =>
    `${kind}:${parent.kind}:${parent.start}:${parent.end}:${field}`;

/**
 * The source lists whose order is meaningful in the graph. A statement must
 * belong to a block (the source of execution lines); members belong to one of
 * the table-like element lists. Every consumer uses this one classification.
 */
function groups(tree: AstReply): ReorderGroup[] {
    const found: ReorderGroup[] = [];
    const visit = (parent: AstNode): void => {
        for (const [field, value] of Object.entries(parent.fields ?? {})) {
            if (Array.isArray(value)) {
                const kind: ReorderSite["kind"] | undefined =
                    parent.kind === "block" && field === "items" ? "statement"
                        : ELEMENT_FIELDS.get(parent.kind)?.has(field) ? "element"
                        : undefined;
                // A singleton has no insertion target, so it must not look
                // draggable merely because it belongs to a reorderable kind.
                if (kind !== undefined && value.length > 1) {
                    found.push({ site: { kind, list: listKey(kind, parent, field) }, items: value });
                }
                for (const child of value) visit(child);
            } else {
                visit(value);
            }
        }
    };
    visit(tree.root);
    for (const { node, field, items } of commaLists(tree)) {
        const key = listKey("element", node, field);
        if (items.length > 1 && !found.some(group => group.site.list === key)) {
            found.push({ site: { kind: "element", list: key }, items });
        }
    }
    return found;
}

/** Markers consumed by the renderer to make all eligible nodes use one D&D UI. */
export function reorderSites(tree: AstReply): ReorderSite[] {
    return groups(tree).flatMap(({ site, items }) => items.map((item) => ({
        ...site, start: item.start, end: item.end,
    })));
}

const sameSpan = (node: AstNode, start: number, end: number) =>
    node.start === start && node.end === end;

/**
 * Rebuild just one sibling-list range in its new order. The separators and
 * comments between source items stay in their original slots, so no source
 * outside the list is reformatted or discarded.
 */
export function reorderEdit(tree: AstReply, request: ReorderRequest): SourceEdit | undefined {
    if (!Number.isInteger(request.sourceStart) || !Number.isInteger(request.sourceEnd) ||
        !Number.isInteger(request.targetStart) || !Number.isInteger(request.targetEnd) ||
        typeof request.before !== "boolean") return undefined;
    const group = groups(tree).find(({ items }) =>
        items.some((item) => sameSpan(item, request.sourceStart, request.sourceEnd)) &&
        items.some((item) => sameSpan(item, request.targetStart, request.targetEnd)));
    if (group === undefined) return undefined;
    const items = group.items;
    const sourceIndex = items.findIndex((item) => sameSpan(item, request.sourceStart, request.sourceEnd));
    const targetIndex = items.findIndex((item) => sameSpan(item, request.targetStart, request.targetEnd));
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return undefined;
    const first = items[0], last = items[items.length - 1];
    if (first === undefined || last === undefined || first.start < 0 || last.end > tree.source.length) return undefined;
    for (let i = 1; i < items.length; i++) {
        const previous = items[i - 1], current = items[i];
        if (previous.end > current.start || current.end > tree.source.length) return undefined;
    }
    const reordered = [...items];
    const [moved] = reordered.splice(sourceIndex, 1);
    if (moved === undefined) return undefined;
    let insertion = request.before ? targetIndex : targetIndex + 1;
    if (sourceIndex < insertion) insertion--;
    reordered.splice(insertion, 0, moved);
    if (reordered.every((item, index) => item === items[index])) return undefined;
    const gaps = items.slice(1).map((item, index) => tree.source.slice(items[index].end, item.start));
    const text = reordered.map((item, index) =>
        `${index === 0 ? "" : gaps[index - 1]}${tree.source.slice(item.start, item.end)}`).join("");
    return { start: first.start, end: last.end, text };
}
