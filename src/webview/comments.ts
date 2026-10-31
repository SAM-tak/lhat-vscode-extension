import { annotationPresentation } from "./annotations";
import { annotationOwners, annotationOwnerKey, annotationArguments } from "../graphAnnotations";
import type { AstNode, AstReply } from "../protocol";
import type { ElkNode, MapOptions } from "./map";
import { labelColumns } from "./labels";
import { commentBlocks } from "../graphComments";

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
            const owner = box.lhat.elementOwner;
            if (owner) {
                const alias = `${owner.start}:${owner.end}`;
                boxes.set(alias, [...boxes.get(alias) ?? [], box]);
            }
        }
        box.children?.forEach(index);
    };
    index(graph);
    const attached = new Map<ElkNode, ElkNode[]>();
    const sideNotes = new Map<ElkNode, ElkNode>();
    let serial = 0;
    const annotations = annotationOwners(reply);
    const visit = (node: AstNode, inherited: ElkNode): void => {
        const matches = boxes.get(`${node.start}:${node.end}`) ?? [];
        const owner = matches.find(box => box.lhat?.kind === node.kind && !box.lhat.layoutOnly && box.lhat.definitionRole !== "row")
            ?? matches.find(box => box.lhat?.kind === node.kind)
            ?? matches.find(box => !box.lhat?.layoutOnly && box.lhat?.definitionRole !== "row")
            ?? inherited;
        const annotationOwner = annotations.find(a => a.start === node.start && a.end === node.end && a.kind === node.kind);
        const sites = annotationOwner?.annotations ?? [];
        if (annotationOwner && (sites.length || options.annotationBoxes?.[annotationOwnerKey(annotationOwner)])) {
            const target = owner.lhat?.definitionRole === "declaration"
                ? matches.find(box => box.lhat?.definitionRole === "row") ?? owner : owner;
            const foldKey = `annotations:${node.kind}:${node.start}:${node.end}`;
            const collapsed = options.folds?.[foldKey] ?? options.collapseAll === true;
            const rows = sites.map(site => annotationPresentation(site,
                reply.annotationChoices?.find(choice => choice.name === annotationArguments(site.text).name), options.vocabulary));
            sideNotes.set(target, {
                id: `annotations__${serial++}`, labels: [{ text: sites.map(a => a.text.replace(/^@/, "")).join("\n") }],
                width: px(collapsed ? 128 : Math.max(128, ...rows.map(row => row.width + 16))) + 2,
                height: px(collapsed ? 30 : 30 + rows.reduce((sum, row) => sum + row.height, 0) + (annotationOwner.canAdd ? 22 : 0)) + 2,
                lhat: { kind: "annotation-list", start: node.start, end: node.end,
                    annotationList: { ...annotationOwner, annotations: sites }, noExecutionHandles: true,
                    foldable: true, foldKey, collapsed, commentOwner: `${node.kind} (${node.line}:${node.column})` },
            });
        }
        for (const comment of commentBlocks(reply.source, node)) {
            // Delimiters and surrounding whitespace are hidden only in the view.
            // Source edits continue to use the untouched reply.source and span.
            const text = comment.text;
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
        for (const [field, child] of Object.entries(node.fields ?? {})) {
            if (field === "annotations") continue;
            for (const item of Array.isArray(child) ? child : [child]) visit(item, owner);
        }
    };
    visit(options.root ?? reply.root, graph);
    if (!attached.size && !sideNotes.size) return graph;

    const gap = px(8);
    // Leave the owner's insertion button (15.4px) below the last comment.
    // Reserve the space in the layout so preceding siblings stay clear too.
    const commentBand = (comments: ElkNode[]) => comments.length
        ? comments.reduce((sum, comment) => sum + comment.height! + gap, 0) + px(16) : 0;
    const linkGutter = (comments: ElkNode[]) => comments.length > 1 ? px(8 + comments.length * 4) : 0;
    const linkComments = (comments: ElkNode[], owner: ElkNode): void => {
        const left = Math.min(...comments.map(comment => comment.x!));
        comments.forEach((comment, index) => {
            const x = owner.x! + (owner.lhat?.synthetic === "start" ? owner.width! / 2
                : Math.min(owner.width! / 4, px(12 + index * 4))) - comment.x!;
            const y = owner.y! - comment.y!;
            const approach = y - px(6);
            if (comments.length > 1) {
                // Route around intervening comments rather than through them.
                const rail = left - px(8 + index * 4) - comment.x!;
                comment.lhat!.commentLink = [{ x: 0, y: comment.height! / 2 }, { x: rail, y: comment.height! / 2 },
                    { x: rail, y: approach }, { x, y: approach }, { x, y }];
            } else {
                const from = Math.max(px(8), Math.min(comment.width! - px(8), x));
                comment.lhat!.commentLink = [{ x: from, y: comment.height! }, { x: from, y: approach }, { x, y: approach }, { x, y }];
            }
        });
    };
    const pack = (parent: ElkNode): void => {
        const originalWidth = parent.width ?? 0, originalHeight = parent.height ?? 0;
        const entries = (parent.children ?? []).map(child => {
            const old = { x: child.x ?? 0, y: child.y ?? 0, w: child.width ?? 0, h: child.height ?? 0 };
            pack(child);
            const comments = (attached.get(child) ?? []).sort((a, b) => a.lhat!.start - b.lhat!.start);
            const band = commentBand(comments);
            const width = Math.max(child.width ?? 0, ...comments.map(comment => comment.width!)) + 2 * linkGutter(comments);
            const side = sideNotes.get(child), sideWidth = side ? side.width! + px(24) : 0;
            const sideY = child.lhat?.definitionRole === "row"
                ? child.children?.find(box => box.lhat?.definitionRole === "declaration")?.y ?? 0 : 0;
            return { child, old, comments, side, sideWidth, sideY, band, contentWidth: width, width: width + sideWidth,
                height: Math.max(child.height ?? 0, side ? side.height! + sideY : 0) + band, x: old.x, y: old.y };
        });
        if (parent.lhat?.definitionRole === "row" && !parent.lhat.stackedDefinition) {
            // Keep both ends of a definition aligned when either side gains comments.
            const pair = entries.filter(entry => ["declaration", "value"].includes(entry.child.lhat?.definitionRole ?? ""));
            const band = Math.max(0, ...pair.map(entry => entry.band));
            for (const entry of pair) {
                entry.height += band - entry.band;
                entry.band = band;
            }
        }
        // Reserve a shared left margin so one sidebar does not move its
        // statement off the execution column used by its siblings.
        const inset = Math.max(0, ...entries.map(entry => entry.sideWidth - entry.old.x));
        for (const entry of entries) entry.x += inset - entry.sideWidth;
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
            const { child, old, comments, side, sideWidth, sideY, band, contentWidth, width, height, x, y } = entry;
            child.x = x + sideWidth + (child.lhat?.definitionRole === "declaration"
                ? linkGutter(comments) : (contentWidth - (child.width ?? 0)) / 2);
            child.y = y + band;
            if (side) {
                side.x = child.x - sideWidth;
                side.y = child.y + sideY;
                side.lhat!.commentAnchor = { id: child.id, dx: -sideWidth, dy: sideY };
                const declaration = child.lhat?.definitionRole === "row"
                    ? child.children?.find(box => box.lhat?.definitionRole === "declaration") : undefined;
                side.lhat!.annotationLinkWidth = px(24) + (declaration?.x ?? 0);
            }
            let top = y;
            for (const comment of comments) {
                comment.x = x + sideWidth + (contentWidth - comment.width!) / 2;
                comment.y = top;
                comment.lhat!.commentAnchor = { id: child.id, dx: comment.x - child.x, dy: top - child.y };
                top += comment.height! + gap;
            }
            linkComments(comments, child);
            growX = Math.max(growX, x + width - old.x - old.w);
            growY = Math.max(growY, y + height - old.y - old.h);
        }
        if (entries.length) parent.children = entries.flatMap(entry => [...entry.comments, ...(entry.side ? [entry.side] : []), entry.child]);
        parent.width = originalWidth + growX;
        parent.height = originalHeight + growY;
        for (const port of parent.ports ?? []) {
            if (port.x === originalWidth) port.x += growX;
            else if (port.x !== undefined) port.x += inset;
            if (port.y === originalHeight) port.y += growY;
        }
    };
    pack(graph);
    // The view root has no rendered box; its comments precede its contents.
    const rootComments = attached.get(graph) ?? [];
    const band = commentBand(rootComments);
    graph.width = Math.max(graph.width ?? 0, ...rootComments.map(comment => comment.width! + 2 * linkGutter(rootComments)));
    for (const child of graph.children ?? []) child.y = (child.y ?? 0) + band;
    let y = 0;
    for (const comment of rootComments) {
        comment.x = ((graph.width ?? 0) - comment.width!) / 2;
        comment.y = y;
        y += comment.height! + gap;
    }
    // A drilled/root scope has no frame; use its execution entry when present.
    const entry = graph.children?.find(child => child.lhat?.synthetic === "start");
    if (entry) {
        for (const comment of rootComments) comment.lhat!.commentAnchor = {
            id: entry.id, dx: comment.x! - entry.x!, dy: comment.y! - entry.y!,
        };
        linkComments(rootComments, entry);
    }
    graph.children = [...rootComments, ...graph.children ?? []];
    graph.height = (graph.height ?? 0) + band;
    const rootSide = sideNotes.get(graph);
    if (rootSide) {
        const inset = rootSide.width! + px(24);
        for (const child of graph.children ?? []) child.x = (child.x ?? 0) + inset;
        rootSide.x = 0; rootSide.y = band;
        graph.children = [rootSide, ...graph.children ?? []];
        graph.width = (graph.width ?? 0) + inset;
        graph.height = Math.max(graph.height ?? 0, band + rootSide.height!);
    }
    return graph;
}
