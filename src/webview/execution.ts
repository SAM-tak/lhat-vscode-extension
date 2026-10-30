import type { AstNode } from "../protocol";
import { syntaxTokens } from "../graphSyntax";

/** Structural fall-through only: do not evaluate conditions or infer whether
 * arbitrary calls/loops terminate. Callable bodies have their own execution. */
export function analyzeExecution(root: AstNode, source: string) {
    const memo = new WeakMap<AstNode, boolean>();
    const mainMemo = new WeakMap<AstNode, boolean>();
    const beforeFinallyMemo = new WeakMap<AstNode, boolean>();
    const unreachable = new WeakSet<AstNode>();
    const unreachableStarts = new Set<number>();
    const field = (node: AstNode, name: string): AstNode[] => {
        const value = node.fields?.[name];
        return Array.isArray(value) ? value : value ? [value] : [];
    };
    const finallyOf = (node: AstNode) => field(node, "extra").find(child => child.kind === "loop-clause" &&
        syntaxTokens(source, child.start, child.end)[0]?.text === "finally^");
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
            // Pattern dispatch and focused conditions choose branches;
            // ordinary loops have block bodies and may execute zero times.
            result = field(node, "body").some(body => body.kind === "if-stmt" && stops(body));
        }
        mainMemo.set(node, result);
        // A handled error may leave the block normally even when its main
        // path returns or raises. Handler paths are alternatives, not a tail.
        const handlers = field(node, "arms");
        if (handlers.length) result = result && handlers.every(stops);
        beforeFinallyMemo.set(node, result);
        const body = field(node, "body")[0];
        const final = finallyOf(node) ?? (["repeat", "for"].includes(node.kind) && body?.kind === "block" ? finallyOf(body) : undefined);
        if (final && stops(final)) result = true;
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
    const stopsBeforeFinally = (node: AstNode): boolean => { stops(node); return beforeFinallyMemo.get(node)!; };
    return { stops, stopsMain, stopsBeforeFinally, finallyOf, unreachable, unreachableStarts };
}

/** Cleanup dependencies are separate from ordinary fall-through: a pending
 * return/break still leaves after cleanup rather than entering the next line. */
export function cleanupTransfers(root: AstNode, source: string, execution: ReturnType<typeof analyzeExecution>) {
    const links: { source: AstNode; target: AstNode }[] = [];
    type Cleanup = { final: AstNode; depth: number; loop?: AstNode };
    const one = (node: AstNode, field: string) => {
        const value = node.fields?.[field]; return Array.isArray(value) ? value[0] : value;
    };
    const visit = (node: AstNode, pending: Cleanup[], loops: AstNode[], parent?: AstNode) => {
        if (node.kind === "disabled" || execution.unreachable.has(node)) return;
        if (node.kind === "func") { pending = []; loops = []; }
        const body = one(node, "body");
        if (["for", "repeat"].includes(node.kind) && body?.kind === "block") loops = [...loops, node];
        if (["return", "panic", "panic-stmt", "break", "next", "continue", "skip"].includes(node.kind)) {
            let active = pending;
            if (["break", "next", "continue", "skip"].includes(node.kind)) {
                const tokens = syntaxTokens(source, node.start, node.end);
                let levels = tokens[0]?.text.match(/\^+$/)?.[0].length ?? 1;
                if (tokens[1]?.text === "[") {
                    try { levels = Number(BigInt(tokens[2].text.replace(/_/g, ""))); } catch { return; }
                }
                const depth = loops.length - levels + 1, target = loops[depth - 1];
                if (!target) return;
                active = pending.filter(cleanup => cleanup.depth >= depth &&
                    (node.kind === "break" || cleanup.loop !== target));
            }
            let previous = node;
            for (const cleanup of [...active].reverse()) {
                links.push({ source: previous, target: cleanup.final });
                previous = cleanup.final;
                if (execution.stops(previous)) break;
            }
        }
        const final = execution.finallyOf(node);
        const cleanup = final && { final, depth: loops.length,
            loop: parent && loops.includes(parent) && one(parent, "body") === node ? parent : undefined };
        for (const child of Object.values(node.fields ?? {}).flat())
            visit(child, cleanup && child !== final ? [...pending, cleanup] : pending, loops, node);
    };
    visit(root, [], []);
    return links;
}
