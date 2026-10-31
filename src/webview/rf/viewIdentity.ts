import type { AstNode, AstReply, SourceSpan } from "../../protocol";
import { commentBlocks } from "../../graphComments";

/** Match syntax identities across source edits, retaining unchanged siblings after insertions. */
export function viewIdentity(before: AstReply, after: AstReply) {
    const nodes = new Map<string, AstNode>();
    const spans = new Map<string, SourceSpan>();
    const key = (span: SourceSpan) => `${span.start}:${span.end}`;
    const match = <T>(old: T[], next: T[], identity: (item: T, previous: boolean) => string,
        compatible: (left: T, right: T) => boolean, pair: (left: T, right: T) => void) => {
        const remaining = new Set(next.map((_, index) => index));
        const candidates = new Map<string, number[]>();
        next.forEach((item, index) => {
            const name = identity(item, false);
            const indices = candidates.get(name) ?? [];
            indices.push(index); candidates.set(name, indices);
        });
        const unmatched: T[] = [];
        for (const item of old) {
            const found = candidates.get(identity(item, true))?.shift();
            if (found === undefined) unmatched.push(item);
            else { remaining.delete(found); pair(item, next[found]); }
        }
        const pending = [...remaining].map(index => next[index]);
        if (unmatched.length === pending.length) unmatched.forEach((item, index) => {
            const candidate = pending[index];
            if (compatible(item, candidate)) pair(item, candidate);
        });
    };
    const pair = (old: AstNode, next: AstNode) => {
        if (old.kind !== next.kind) return;
        nodes.set(`${old.kind}:${key(old)}`, next);
        spans.set(key(old), next);
        match(commentBlocks(before.source, old), commentBlocks(after.source, next), item => item.text,
            (a, b) => a.block === b.block, (a, b) => spans.set(key(a), b));
        for (const [field, value] of Object.entries(old.fields ?? {})) {
            const updated = next.fields?.[field];
            if (!updated) continue;
            match(Array.isArray(value) ? value : [value], Array.isArray(updated) ? updated : [updated],
                (node, previous) => `${node.kind}:${(previous ? before : after).source.slice(node.start, node.end)}`,
                (a, b) => a.kind === b.kind, pair);
        }
    };
    pair(before.root, after.root);
    return {
        target<T extends SourceSpan & { kind: string }>(target: T): T | undefined {
            const next = nodes.get(`${target.kind}:${key(target)}`);
            return next && { ...target, start: next.start, end: next.end };
        },
        keys<T>(values: Record<string, T>): Record<string, T> {
            return Object.fromEntries(Object.entries(values).flatMap(([name, value]) => {
                const parts = /^(.*):(\d+):(\d+)$/.exec(name);
                const next = parts && (nodes.get(`${parts[1].replace(/^annotations:/, "")}:${parts[2]}:${parts[3]}`)
                    ?? spans.get(`${parts[2]}:${parts[3]}`));
                return next ? [[`${parts![1]}:${key(next)}`, value]] : [];
            }));
        },
    };
}
