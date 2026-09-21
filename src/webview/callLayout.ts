import type { ElkNode, ElkEdge } from "./map";

/** Compact call cards and a shared column for each argument depth. An index,
 * table or function remains a separate expression/scope, with its own layout.
 * Only immediate call arguments join the same tree. Source evaluation/order
 * is unchanged; the edges below are display links, not execution edges.
 */
export function arrangeCallTrees(root: ElkNode, scale: number): ElkNode {
    const px = (value: number) => Math.round(value * scale);
    // A compact card consists of fixed-size cells and ordered rows/columns.
    // Give its enclosing statement ports this width, so the execution column
    // follows the first card rather than the centre of its entire call tree.
    const cardWidth = (node: ElkNode): number => {
        if (node.width !== undefined) return node.width;
        const options = node.layoutOptions ?? {}, children = node.children ?? [];
        const horizontal = ["LEFT", "RIGHT"].includes(options["elk.direction"]);
        const padding = options["elk.padding"] ?? "";
        const left = Number(/left=(\d+)/.exec(padding)?.[1] ?? 0), right = Number(/right=(\d+)/.exec(padding)?.[1] ?? 0);
        const widths = children.map(cardWidth);
        const content = horizontal ? widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * Number(options["elk.layered.spacing.nodeNodeBetweenLayers"] ?? px(22))
            : Math.max(0, ...widths);
        const minimum = Number(/\(([\d.]+)/.exec(options["elk.nodeSize.minimum"] ?? "")?.[1] ?? 0);
        return Math.max(minimum, content + left + right);
    };
    const order = (id: string, nodes: ElkNode[], ports = false): ElkEdge[] => nodes.slice(1).map((node, i) => ({
        id: `${id}__order${i}`, sources: [nodes[i].id + (ports ? "__flow-out" : "")],
        targets: [node.id + (ports ? "__flow-in" : "")], pinned: true,
    }));
    const group = (id: string, children: ElkNode[], direction: string): ElkNode => ({
        id, children, edges: [],
        layoutOptions: {
            "elk.algorithm": "layered", "elk.direction": direction,
            "elk.padding": "[top=0,left=0,bottom=0,right=0]",
            "elk.spacing.nodeNode": `${px(22)}`,
            "elk.layered.spacing.nodeNodeBetweenLayers": `${px(direction === "RIGHT" ? 36 : 22)}`,
        },
        lhat: { kind: "call-column", start: root.lhat?.start ?? 0, end: root.lhat?.end ?? 0,
            layoutOnly: true, noExecutionHandles: true },
    });
    const visit = (node: ElkNode): ElkNode => {
        if (!node.lhat?.invocation) {
            node.children = node.children?.map(visit);
            if (node.layoutOptions?.["elk.direction"] === "DOWN") {
                const calls = new Set(node.children?.filter(child => child.lhat?.callTree && !child.lhat?.definitionRole)
                    .map(child => child.id));
                for (const edge of node.edges ?? []) if (!edge.definition) {
                    edge.sources = edge.sources.map(id => calls.has(id) ? `${id}__flow-out` : id);
                    edge.targets = edge.targets.map(id => calls.has(id) ? `${id}__flow-in` : id);
                }
            }
            return node;
        }
        const original = { ...node.lhat }, id = node.id, ports = node.ports;
        // The wrapper keeps the externally addressed ID/ports. The visible
        // first card owns execution handles, and its output slots own values.
        node.id = `${id}__card`;
        node.ports = undefined;
        node.lhat = { ...node.lhat, definitionRole: undefined, definitionHandleY: undefined };
        const columns: ElkNode[][] = [], links: { source: string; target: string; column: number }[] = [];
        const arguments_: { owner: string; value: string; input: string }[] = [];
        const collect = (card: ElkNode, depth: number): void => {
            (columns[depth] ??= []).push(card);
            if (card.children?.[0]) card.children[0] = visit(card.children[0]);
            const groups = card.children?.find(child => child.lhat?.kind === "call-groups");
            const input = groups?.children?.find(child => child.lhat?.callInputWidth !== undefined);
            if (!input) return;
            const rows = input.children ?? [], slots: ElkNode[] = [];
            for (const row of rows) {
                if (row.lhat?.synthetic === "add") { slots.push(row); continue; }
                const slot = row.children?.[0], value = row.children?.[1];
                if (!slot || !value) continue;
                slots.push(slot);
                arguments_.push({ owner: card.id, value: value.id, input: slot.id });
                const output = value.lhat?.definitionOutputs;
                if (!output || output.length) links.push({ source: output?.[0] ?? value.id, target: slot.id, column: depth });
                if (value.lhat?.invocation) collect(value, depth + 1);
                else (columns[depth + 1] ??= []).push(visit(value));
            }
            input.children = slots;
            input.edges = order(input.id, slots);
            input.lhat = { ...input.lhat!, callInputWidth: undefined };
        };
        collect(node, 0);
        const children = columns.map((items, depth) => {
            const column = group(`${id}__column${depth}`, items, "DOWN");
            for (const item of items) {
                item.layoutOptions = { ...item.layoutOptions, "elk.portConstraints": "FIXED_POS" };
                item.ports = [...item.ports ?? [], ...["in", "out"].map(end => ({
                    id: `${item.id}__flow-${end}`, x: 0, y: 0,
                    layoutOptions: { "elk.port.side": end === "in" ? "NORTH" : "SOUTH" },
                }))];
            }
            column.edges = order(column.id, items, true);
            column.layoutOptions!["elk.portConstraints"] = "FIXED_POS";
            column.ports = ["WEST", "EAST"].map(side => ({ id: `${column.id}__${side}`, x: 0, y: 0,
                layoutOptions: { "elk.port.side": side } }));
            return column;
        });
        const tree = group(id, children, "RIGHT");
        tree.ports = [...ports ?? [], ...["in", "out"].map(end => ({
            id: `${id}__flow-${end}`, x: cardWidth(node) / 2, y: 0,
            layoutOptions: { "elk.port.side": end === "in" ? "NORTH" : "SOUTH" },
        }))];
        tree.layoutOptions!["elk.portConstraints"] = "FIXED_POS";
        tree.edges = children.slice(1).map((column, i) => ({ id: `${id}__depth${i}`,
            sources: [`${children[i].id}__EAST`], targets: [`${column.id}__WEST`], pinned: true }));
        tree.lhat = { ...original, kind: "call-tree", invocation: undefined, callTree: true,
            layoutOnly: true, noExecutionHandles: true, executionNode: node.id,
            insertion: undefined, reorder: undefined, definitionLinks: links, callArguments: arguments_ };
        return tree;
    };
    return visit(root);
}

/** Place ordered argument subtrees after ELK has measured the cards. Calls
 * prefer their parent's top; other values prefer the consuming input's Y.
 * Depth contours reserve space for descendants, not just the leading card.
 */
function placeCallTree(tree: ElkNode): void {
    const columns = tree.children ?? [], items = new Map<string, ElkNode>();
    const offsets = new Map<string, number>();
    const gap = Number(tree.layoutOptions?.["elk.spacing.nodeNode"] ?? 22);
    const argumentsByOwner = new Map<string, { value: string; input: string }[]>();
    for (const argument of tree.lhat?.callArguments ?? []) {
        const list = argumentsByOwner.get(argument.owner) ?? [];
        list.push(argument);
        argumentsByOwner.set(argument.owner, list);
    }
    const index = (node: ElkNode, y: number): void => {
        offsets.set(node.id, y + (node.lhat?.definitionHandleY ?? (node.height ?? 0) / 2));
        node.children?.forEach(child => index(child, y + (child.y ?? 0)));
    };
    for (const column of columns) for (const item of column.children ?? []) {
        items.set(item.id, item);
        if (item.lhat?.inline && item.lhat.kind === "index") item.lhat.definitionHandleY = (item.height ?? 0) / 2;
        index(item, 0);
    }
    type Placement = { node: ElkNode; y: number; depth: number };
    type Subtree = { placements: Placement[]; top: number[]; bottom: number[] };
    const layout = (node: ElkNode): Subtree => {
        const result: Subtree = { placements: [{ node, y: 0, depth: 0 }], top: [0], bottom: [node.height ?? 0] };
        for (const argument of argumentsByOwner.get(node.id) ?? []) {
            const child = items.get(argument.value);
            if (!child) continue;
            const branch = layout(child);
            let y = child.lhat?.invocation ? 0
                : Math.max(0, (offsets.get(argument.input) ?? 0) - (offsets.get(child.id) ?? 0));
            for (let depth = 0; depth < branch.top.length; depth++) {
                const bottom = result.bottom[depth + 1];
                if (bottom !== undefined) y = Math.max(y, bottom + gap - branch.top[depth]);
            }
            for (const placement of branch.placements) result.placements.push({
                node: placement.node, y: placement.y + y, depth: placement.depth + 1,
            });
            for (let depth = 0; depth < branch.top.length; depth++) {
                result.top[depth + 1] = Math.min(result.top[depth + 1] ?? Infinity, branch.top[depth] + y);
                result.bottom[depth + 1] = Math.max(result.bottom[depth + 1] ?? 0, branch.bottom[depth] + y);
            }
        }
        return result;
    };
    const first = columns[0]?.children?.[0];
    if (!first) return;
    for (const placement of layout(first).placements) {
        placement.node.x = 0;
        placement.node.y = placement.y;
    }
    for (const column of columns) {
        column.y = 0;
        column.width = Math.max(0, ...column.children?.map(item => item.width ?? 0) ?? []);
        column.height = Math.max(0, ...column.children?.map(item => (item.y ?? 0) + (item.height ?? 0)) ?? []);
    }
    tree.height = Math.max(0, ...columns.map(column => column.height ?? 0));
}

/** Keep enclosing frames and later siblings clear when a measured subtree
 * grows. Preserve ELK's padding and existing gaps, including LEFT layouts. */
function growContainer(node: ElkNode, before: { x: number; y: number; width: number; height: number }[]): void {
    const children = node.children ?? [];
    const horizontal = ["LEFT", "RIGHT"].includes(node.layoutOptions?.["elk.direction"] ?? "");
    let dx = 0, dy = 0;
    children.forEach((child, i) => {
        const old = before[i];
        let shift = 0;
        children.forEach((other, j) => {
            if (i === j) return;
            const previous = before[j];
            if (horizontal ? previous.x + previous.width <= old.x : previous.y + previous.height <= old.y) {
                shift += Math.max(0, horizontal ? (other.width ?? 0) - previous.width : (other.height ?? 0) - previous.height);
            }
        });
        child.x = old.x + (horizontal ? shift : 0);
        child.y = old.y + (horizontal ? 0 : shift);
        dx = Math.max(dx, child.x + (child.width ?? 0) - old.x - old.width);
        dy = Math.max(dy, child.y + (child.height ?? 0) - old.y - old.height);
    });
    node.width = (node.width ?? 0) + dx;
    node.height = (node.height ?? 0) + dy;
    for (const port of node.ports ?? []) {
        if (port.layoutOptions["elk.port.side"] === "EAST") port.x += dx;
        if (port.layoutOptions["elk.port.side"] === "SOUTH") port.y += dy;
    }
}

/** Align measured inputs, pack argument subtrees, then route in column gaps. */
export function alignCallPorts(root: ElkNode): void {
    const visit = (node: ElkNode): void => {
        const before = node.children?.map(child => ({ x: child.x ?? 0, y: child.y ?? 0,
            width: child.width ?? 0, height: child.height ?? 0 })) ?? [];
        node.children?.forEach(visit);
        if (before.length && !node.lhat?.callTree && node.lhat?.kind !== "call-column") growContainer(node, before);
        if (node.lhat?.invocation) {
            const groups = node.children?.find(child => child.lhat?.kind === "call-groups");
            if (groups) {
                // ELK centres children along a vertical chain; the input
                // instead follows the right padding, including wide titles.
                const padding = Number(/right=(\d+)/.exec(node.layoutOptions?.["elk.padding"] ?? "")?.[1] ?? 0);
                const right = (node.width ?? 0) - padding;
                groups.x = right - (groups.width ?? 0);
            }
        }
        if (!node.lhat?.callTree) return;
        placeCallTree(node);
        const columns = node.children ?? [], points = new Map<string, { x: number; y: number }>();
        const index = (child: ElkNode, x: number, y: number): void => {
            x += child.x ?? 0;
            y += child.y ?? 0;
            points.set(child.id, { x: x + (child.width ?? 0),
                y: y + (child.lhat?.definitionHandleY ?? (child.height ?? 0) / 2) });
            if (!child.lhat?.callTree) child.children?.forEach(item => index(item, x, y));
        };
        columns.forEach(column => index(column, 0, 0));
        const baseGap = Number(node.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"] ?? 36);
        const laneGap = baseGap / 3;
        const assignments = new Map<string, number>(), laneCounts: number[] = [];
        for (let depth = 0; depth < columns.length - 1; depth++) {
            const ends: number[] = [];
            const links = (node.lhat.definitionLinks ?? []).filter(link => link.column === depth)
                .map(link => ({ link, top: Math.min(points.get(link.source)?.y ?? 0, points.get(link.target)?.y ?? 0),
                    bottom: Math.max(points.get(link.source)?.y ?? 0, points.get(link.target)?.y ?? 0) }))
                .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
            for (const { link, top, bottom } of links) {
                let lane = ends.findIndex(end => end + laneGap < top);
                if (lane < 0) lane = ends.length;
                ends[lane] = bottom;
                assignments.set(link.target, lane);
            }
            laneCounts[depth] = Math.max(1, ends.length);
        }
        let x = 0;
        columns.forEach((column, depth) => {
            column.x = x;
            x += (column.width ?? 0) + Math.max(baseGap, ((laneCounts[depth] ?? 1) + 1) * laneGap);
        });
        node.width = columns.length ? (columns[columns.length - 1].x ?? 0) + (columns[columns.length - 1].width ?? 0) : 0;
        columns.forEach(column => index(column, 0, 0));
        for (const link of node.lhat.definitionLinks ?? []) {
            if (link.column === undefined) continue;
            const left = columns[link.column], right = columns[link.column + 1], target = points.get(link.target);
            if (!left || !right || !target) continue;
            const start = (left.x ?? 0) + (left.width ?? 0), count = laneCounts[link.column];
            const lane = start + ((right.x ?? 0) - start) * ((assignments.get(link.target) ?? 0) + 1) / (count + 1);
            link.laneOffset = lane - target.x;
        }
    };
    visit(root);
}
