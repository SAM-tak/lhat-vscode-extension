import type { AstNode, AstReply } from "../protocol";
import type { ElkNode, MapOptions } from "./map";
import { labelColumns } from "./labels";

/** Display comments after the normal layout, keeping source text and spans intact.
 * Keep existing endpoint IDs and reserve space rather than overlaying code.
 */
export function placeComments(graph: ElkNode, reply: AstReply, options: MapOptions = {}): ElkNode {
    const scale = options.scale ?? 1;
    const px = (n: number) => Math.round(n * scale);
    const boxes = new Map<string, ElkNode[]>();
    const index = (box: ElkNode): void => {
        if (box.lhat && !box.lhat.synthetic) {
            const key = `${box.lhat.start}:${box.lhat.end}`;
            boxes.set(key, [...boxes.get(key) ?? [], box]);
        }
        box.children?.forEach(index);
    };
    index(graph);
    const attached = new Map<ElkNode, ElkNode[]>();
    let serial = 0;
    const visit = (node: AstNode, inherited: ElkNode): void => {
        const matches = boxes.get(`${node.start}:${node.end}`) ?? [];
        const owner = matches.find(box => box.lhat?.kind === node.kind && !box.lhat.layoutOnly && box.lhat.definitionRole !== "row")
            ?? matches.find(box => box.lhat?.kind === node.kind)
            ?? matches.find(box => !box.lhat?.layoutOnly && box.lhat?.definitionRole !== "row")
            ?? inherited;
        for (const comment of node.comments ?? []) {
            // Delimiters and surrounding whitespace are hidden only in the view.
            // Source edits continue to use the untouched reply.source and span.
            const raw = reply.source.slice(comment.start, comment.end);
            const text = (comment.block && raw.startsWith("#[")
                ? raw.slice(2, raw.endsWith("]#") ? -2 : undefined)
                : raw.startsWith("#") ? raw.slice(1) : raw).trim();
            const lines: string[] = [];
            for (const line of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
                let part = "";
                for (const char of line) {
                    if (part && labelColumns(part + char) > 48) { lines.push(part); part = ""; }
                    part += char;
                }
                lines.push(part);
            }
            const foldKey = `comment:${comment.start}:${comment.end}`;
            const collapsed = options.folds?.[foldKey] ?? options.collapseAll === true;
            const visible = collapsed ? [lines[0] + (lines.length > 1 ? "…" : "")] : lines;
            const box: ElkNode = {
                id: `comment__${serial++}`,
                labels: [{ text: visible.join("\n") }],
                width: px(Math.max(100, Math.max(...visible.map(labelColumns)) * 7.2 + 36)) + 2,
                height: px(visible.length * 18 + 16) + 2,
                lhat: { kind: "comment", start: comment.start, end: comment.end,
                    noExecutionHandles: true, foldable: true, foldKey, collapsed,
                    commentOwner: `${node.kind} (${node.line}:${node.column})` },
            };
            attached.set(owner, [...attached.get(owner) ?? [], box]);
        }
        // Folding continues to hide the contents, including their comments.
        if (owner.lhat?.collapsed) return;
        for (const child of Object.values(node.fields ?? {})) {
            for (const item of Array.isArray(child) ? child : [child]) visit(item, owner);
        }
    };
    visit(options.root ?? reply.root, graph);
    if (!attached.size) return graph;

    const gap = px(8);
    // Leave the owner's insertion button (15.4px) below the last comment.
    // Reserve the space in the layout so preceding siblings stay clear too.
    const commentBand = (comments: ElkNode[]) => comments.length
        ? comments.reduce((sum, comment) => sum + comment.height! + gap, 0) + px(16) : 0;
    const pack = (parent: ElkNode): void => {
        const originalWidth = parent.width ?? 0, originalHeight = parent.height ?? 0;
        const entries = (parent.children ?? []).map(child => {
            const old = { x: child.x ?? 0, y: child.y ?? 0, w: child.width ?? 0, h: child.height ?? 0 };
            pack(child);
            const comments = (attached.get(child) ?? []).sort((a, b) => a.lhat!.start - b.lhat!.start);
            const band = commentBand(comments);
            const width = Math.max(child.width ?? 0, ...comments.map(comment => comment.width!));
            return { child, old, comments, band, width, height: (child.height ?? 0) + band, x: old.x, y: old.y };
        });
        // Preserve every original left/right and above/below separation. This
        // also works for fixed call cells, which ELK does not lay out again.
        for (const entry of [...entries].sort((a, b) => a.old.x - b.old.x)) {
            for (const before of entries) if (before !== entry && before.old.x + before.old.w <= entry.old.x) {
                entry.x = Math.max(entry.x, before.x + before.width + entry.old.x - before.old.x - before.old.w);
            }
        }
        for (const entry of [...entries].sort((a, b) => a.old.y - b.old.y)) {
            for (const before of entries) if (before !== entry && before.old.y + before.old.h <= entry.old.y) {
                entry.y = Math.max(entry.y, before.y + before.height + entry.old.y - before.old.y - before.old.h);
            }
        }
        let growX = 0, growY = 0;
        for (const entry of entries) {
            const { child, old, comments, band, width, height, x, y } = entry;
            child.x = x + (width - (child.width ?? 0)) / 2;
            child.y = y + band;
            let top = y;
            for (const comment of comments) {
                comment.x = x + (width - comment.width!) / 2;
                comment.y = top;
                comment.lhat!.commentAnchor = { id: child.id, dy: top - child.y };
                top += comment.height! + gap;
            }
            growX = Math.max(growX, x + width - old.x - old.w);
            growY = Math.max(growY, y + height - old.y - old.h);
        }
        if (entries.length) parent.children = entries.flatMap(entry => [...entry.comments, entry.child]);
        parent.width = originalWidth + growX;
        parent.height = originalHeight + growY;
        for (const port of parent.ports ?? []) {
            if (port.x === originalWidth) port.x += growX;
            if (port.y === originalHeight) port.y += growY;
        }
    };
    pack(graph);
    // The view root has no rendered box; its comments precede its contents.
    const rootComments = attached.get(graph) ?? [];
    const band = commentBand(rootComments);
    graph.width = Math.max(graph.width ?? 0, ...rootComments.map(comment => comment.width!));
    for (const child of graph.children ?? []) child.y = (child.y ?? 0) + band;
    let y = 0;
    for (const comment of rootComments) {
        comment.x = ((graph.width ?? 0) - comment.width!) / 2;
        comment.y = y;
        y += comment.height! + gap;
    }
    graph.children = [...rootComments, ...graph.children ?? []];
    graph.height = (graph.height ?? 0) + band;
    return graph;
}
