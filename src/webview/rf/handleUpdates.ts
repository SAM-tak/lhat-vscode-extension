/** Relative port geometry. Moving a whole node needs no DOM remeasurement. */
export interface HandleNode {
    id: string;
    data: {
        flowHandleX?: number; definitionHandleY?: number; definitionRole?: string;
        noExecutionHandles: boolean; isAdd: boolean; isStart: boolean; isCondition: boolean;
        branchOffset?: number; definitionBranchOffset?: number;
        executionAppend?: boolean; executionMerge?: boolean;
        executionTerminal?: boolean;
    };
}

/** Mounts/resizes are already batched by React Flow's ResizeObserver. Only
 * changes inside an existing, unchanged-size box need an explicit update.
 */
export function changedHandles(nodes: HandleNode[], previous: Map<string, string>): { changed: string[]; geometry: Map<string, string> } {
    const changed: string[] = [], geometry = new Map<string, string>();
    for (const { id, data: d } of nodes) {
        const signature = JSON.stringify([d.flowHandleX, d.definitionHandleY, d.definitionRole,
            d.noExecutionHandles, d.isAdd, d.isStart, d.isCondition, d.branchOffset, d.definitionBranchOffset,
            d.executionAppend, d.executionMerge, d.executionTerminal]);
        geometry.set(id, signature);
        if (previous.has(id) && previous.get(id) !== signature) changed.push(id);
    }
    return { changed, geometry };
}
