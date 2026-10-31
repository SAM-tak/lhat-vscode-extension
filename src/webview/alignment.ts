import type { ElkNode } from "./map";

/** A statement's insertion control occupies the space to the left of this axis. */
export const EXECUTION_INSET = 24;

/** Align vertical lists by their reading edge and execution sequences by their entry port. */
export function leftAlignColumns(graph: ElkNode, scale = 1): ElkNode {
    const inset = Math.round(EXECUTION_INSET * scale);
    const index = new Map<string, ElkNode>();
    const collect = (node: ElkNode) => { index.set(node.id, node); node.children?.forEach(collect); };
    collect(graph);
    const relative = (node: ElkNode, id: string): number | undefined => {
        for (const child of node.children ?? []) {
            const x = child.id === id ? 0 : relative(child, id);
            if (x !== undefined) return (child.x ?? 0) + x;
        }
        return undefined;
    };
    const axis = (node: ElkNode): number => {
        const target = node.lhat?.executionNode ?? node.lhat?.executionEntry;
        const endpoint = target && index.get(target);
        const x = endpoint && endpoint !== node ? relative(node, target!) : undefined;
        if (endpoint && x !== undefined) return x + axis(endpoint);
        if (node.lhat?.noExecutionHandles || !node.lhat) return 0;
        return node.lhat.executionHandleX ?? inset;
    };
    const visit = (node: ElkNode) => {
        const children = node.children ?? [];
        const before = children.map(child => ({ x: child.x ?? 0, width: child.width ?? 0 }));
        children.forEach(visit);
        const horizontal = ["RIGHT", "LEFT"].includes(node.layoutOptions?.["elk.direction"] ?? "");
        if (horizontal) children.forEach((child, i) => {
            child.x = before[i].x + children.reduce((shift, sibling, j) => shift + (j !== i &&
                before[j].x + before[j].width <= before[i].x ? (sibling.width ?? 0) - before[j].width : 0), 0);
        });
        const metadata = node.lhat;
        if (metadata && !metadata.noExecutionHandles && !metadata.condition) {
            metadata.executionHandleX ??= metadata.synthetic || metadata.pictogram === "return"
                ? (node.width ?? inset) / 2 : Math.min(inset, Math.max(6, (node.width ?? inset + 6) - 6));
        }
        const notes = children.filter(child => child.lhat?.commentAnchor);
        const items = children.filter(child => !child.lhat?.commentAnchor && !child.lhat?.condition && !child.lhat?.annotationList);
        const sideWidth = Math.max(0, ...children.filter(child => child.lhat?.annotationList && !child.lhat.commentAnchor)
            .map(child => (child.x ?? 0) + (child.width ?? 0) + inset));
        const padding = node.layoutOptions?.["elk.padding"] ?? "";
        const left = Number(/left=([\d.]+)/.exec(padding)?.[1] ?? 0);
        const right = Number(/right=([\d.]+)/.exec(padding)?.[1] ?? 0);
        if (node.layoutOptions?.["elk.direction"] === "DOWN" && !metadata?.executionBranches?.length && !metadata?.invocation) {
            const execution = (node.edges ?? []).some(edge => edge.drawn && !edge.definition);
            const anchor = (child: ElkNode) => execution ? axis(child) : 0;
            const column = left + sideWidth + Math.max(0, ...items.map(child => anchor(child) - Math.min(0,
                ...notes.filter(note => note.lhat!.commentAnchor!.id === child.id).map(note => note.lhat!.commentAnchor!.dx ?? 0))));
            for (const child of items) child.x = column - anchor(child);
        }
        for (const note of notes) {
            const anchor = note.lhat!.commentAnchor!, owner = index.get(anchor.id);
            if (!owner) continue;
            const x = relative(node, owner.id), y = owner.y ?? 0;
            if (x !== undefined) note.x = x + (anchor.dx ?? ((owner.width ?? 0) - (note.width ?? 0)) / 2);
            // Sidebars can follow a declaration nested inside a definition row.
            if (children.includes(owner)) note.y = y + anchor.dy;
        }
        if (children.length) {
            const minimum = Number(/\(([\d.]+)/.exec(node.layoutOptions?.["elk.nodeSize.minimum"] ?? "")?.[1] ?? 0);
            node.width = Math.max(minimum, ...children.map(child => (child.x ?? 0) + (child.width ?? 0) + right));
        }
    };
    visit(graph);
    return graph;
}
