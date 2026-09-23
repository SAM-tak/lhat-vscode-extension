import ELK, { type ElkNode as LayoutGraph } from "elkjs/lib/elk-api.js";
import { toElk, stackWideDefinitions, type ElkNode } from "../map";
import type { LayoutEngine } from "./layoutClient";
import { placeComments } from "../comments";

/** VS Code webviews require blob/data workers; the bundle contains every import. */
export async function createLayoutEngine(url: string): Promise<LayoutEngine> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load graph layout worker (${response.status}).`);
    const blob = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
    let worker: Worker;
    try { worker = new Worker(blob); } finally { URL.revokeObjectURL(blob); }
    const elk = new ELK({ workerFactory: () => worker });
    let failure: Error | undefined;
    let rejectCurrent: ((reason: Error) => void) | undefined;
    worker.onerror = event => {
        event.preventDefault();
        failure = new Error(event.message);
        rejectCurrent?.(failure);
    };
    return {
        async layout(reply, options) {
            if (failure) throw failure;
            const started = performance.now();
            const mapped = toElk(reply, options);
            const laid = await new Promise<ElkNode>((resolve, reject) => {
                rejectCurrent = reject;
                elk.layout(mapped as LayoutGraph).then(graph => resolve(graph as ElkNode), reject);
            }).finally(() => { rejectCurrent = undefined; });
            const graph = placeComments(stackWideDefinitions(laid, options.width ?? Infinity), reply, options);
            return { graph, elapsed: performance.now() - started };
        },
        dispose() {
            rejectCurrent?.(new Error("Graph layout worker disposed."));
            worker.terminate();
        },
    };
}
