import type { AstComment, AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { annotationOwners } from "./graphAnnotations";

export interface CommentTarget extends SourceSpan { kind: string }

export function commentTargets(tree: AstReply): CommentTarget[] {
    const targets: CommentTarget[] = [];
    const visit = (node: AstNode) => {
        if (["annotation", "disabled", "interp-text"].includes(node.kind)) return;
        if (node !== tree.root && node.end > node.start) targets.push({ start: node.start, end: node.end, kind: node.kind });
        Object.entries(node.fields ?? {}).filter(([key]) => key !== "annotations").forEach(([, children]) =>
            (Array.isArray(children) ? children : [children]).forEach(visit));
    };
    visit(tree.root);
    return targets;
}

export function editComment(tree: AstReply, site: SourceSpan, action: "add" | "remove"): SourceEdit | undefined {
    if (action === "add") {
        const target = commentTargets(tree).find(node => node.start === site.start && node.end === site.end);
        if (!target) return undefined;
        const annotations = annotationOwners(tree).find(node => node.start === target.start && node.end === target.end)?.annotations ?? [];
        const start = Math.min(target.start, ...annotations.map(annotation => annotation.start));
        const line = tree.source.slice(tree.source.lastIndexOf("\n", start - 1) + 1, start);
        const indent = /^[\t ]*/.exec(line)![0];
        const newline = tree.source.includes("\r\n") ? "\r\n" : "\n";
        return { start, end: start, text: `${line.trim() ? newline + indent : ""}# comment${newline}${indent}` };
    }
    if (action !== "remove") return undefined;
    let found = false;
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        found ||= commentBlocks(tree.source, node).some(block => block.start === site.start && block.end === site.end);
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root);
    if (!found) return undefined;
    let { start, end } = site;
    const lineStart = tree.source.lastIndexOf("\n", start - 1) + 1;
    const nextLine = tree.source.indexOf("\n", end);
    const lineEnd = nextLine < 0 ? tree.source.length : nextLine;
    if (!tree.source.slice(lineStart, start).trim() && !tree.source.slice(end, lineEnd).trim()) {
        start = lineStart; end = nextLine < 0 ? lineEnd : nextLine + 1;
    }
    return { start, end, text: "" };
}

/** Consecutive full-line comments form one editable block; code and blank lines split it. */
export function commentBlocks(source: string, node: AstNode): (AstComment & { text: string })[] {
    const blocks: (AstComment & { text: string })[] = [];
    for (const comment of node.comments ?? []) {
        const raw = source.slice(comment.start, comment.end);
        if (raw.startsWith("#[~")) continue;
        const text = (comment.block ? raw.slice(2, raw.endsWith("]#") ? -2 : undefined) : raw.slice(1)).trim();
        const previous = blocks[blocks.length - 1];
        const fullLine = !source.slice(source.lastIndexOf("\n", comment.start - 1) + 1, comment.start).trim();
        const previousFullLine = previous && !source.slice(source.lastIndexOf("\n", previous.start - 1) + 1, previous.start).trim();
        if (previous && !previous.block && !comment.block && fullLine && previousFullLine &&
            /^[\t ]*\r?\n[\t ]*$/.test(source.slice(previous.end, comment.start))) {
            previous.end = comment.end;
            previous.text += "\n" + text;
        } else blocks.push({ ...comment, text });
    }
    return blocks;
}
