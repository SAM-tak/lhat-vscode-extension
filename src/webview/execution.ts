import type { AstNode } from "../protocol";

/** Structural fall-through only: do not evaluate conditions or infer whether
 * arbitrary calls/loops terminate. Callable bodies have their own execution. */
export function analyzeExecution(root: AstNode, source: string) {
    const memo = new WeakMap<AstNode, boolean>();
    const mainMemo = new WeakMap<AstNode, boolean>();
    const unreachable = new WeakSet<AstNode>();
    const unreachableStarts = new Set<number>();
    const field = (node: AstNode, name: string): AstNode[] => {
        const value = node.fields?.[name];
        return Array.isArray(value) ? value : value ? [value] : [];
    };
    const stops = (node: AstNode): boolean => {
        const known = memo.get(node);
        if (known !== undefined) return known;
        let result = false;
        // Loop transfers end this path just like return. Their destination
        // is outside the sequence; do not draw a fall-through/merge edge.
        if (["return", "panic", "panic-stmt", "break", "next", "continue", "skip"].includes(node.kind)) result = true;
        else if (["call-stmt", "call", "unary", "expr-stmt"].includes(node.kind) &&
            /^panic\^(?!\^)/.test(source.slice(node.start, node.end))) result = true;
        else if (node.kind === "call-stmt" || node.kind === "expr-stmt") result = field(node, "value").some(stops);
        else if (node.kind === "block") result = field(node, "items").some(stops);
        else if (node.kind === "loop-clause") result = field(node, "body").some(stops);
        else if (node.kind === "with") result = ["items", "body", "extra"].some(name => field(node, name).some(stops));
        else if (node.kind === "if-clause") result = field(node, "body").some(stops);
        else if (node.kind === "if-stmt") {
            const arms = field(node, "items").filter(child => child.kind === "if-clause");
            result = arms.some(arm => arm.fields?.condition === undefined) && arms.every(stops);
        } else if (node.kind === "for") {
            // Pattern dispatch is a branch, unlike an ordinary possibly-empty loop.
            result = field(node, "body").some(body => body.kind === "if-stmt" && source[body.start] === "{" && stops(body));
        }
        mainMemo.set(node, result);
        // A handled error may leave the block normally even when its main
        // path returns or raises. Handler paths are alternatives, not a tail.
        const handlers = field(node, "arms");
        if (handlers.length) result = result && handlers.every(stops);
        memo.set(node, result);
        return result;
    };
    const visit = (node: AstNode, dead = false): void => {
        if (dead) { unreachable.add(node); unreachableStarts.add(node.start); }
        const sequence = node.kind === "block" ? "items" : node.kind === "loop-clause" ? "body" : undefined;
        for (const [name, value] of Object.entries(node.fields ?? {})) {
            let ended = dead;
            for (const child of Array.isArray(value) ? value : [value]) {
                visit(child, ended);
                if (name === sequence && stops(child)) ended = true;
            }
        }
    };
    visit(root);
    const stopsMain = (node: AstNode): boolean => { stops(node); return mainMemo.get(node)!; };
    return { stops, stopsMain, unreachable, unreachableStarts };
}
