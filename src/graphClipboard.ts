import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { annotationOwners, validAnnotation } from "./graphAnnotations";
import { commentBlocks, editComment } from "./graphComments";
import { commaLists, insertAt } from "./graphLists";
import { deleteFromGraph, deleteSites } from "./graphDelete";
import { statementSites } from "./graphStatements";
import { syntaxTokens } from "./graphSyntax";
import { replacementSpan } from "./graphExpressions";

export interface ClipboardTarget extends SourceSpan { category: "node" | "annotation" | "annotations" | "comment"; kind?: string }
export interface ClipboardFragment { text: string; category: "node" | "annotation" | "comment"; indent: string; statement?: boolean }
const same = (a: SourceSpan, b: SourceSpan) => a.start === b.start && a.end === b.end;
const indentAt = (source: string, at: number) => /^[\t ]*/.exec(source.slice(source.lastIndexOf("\n", at - 1) + 1, at))![0];

function selection(tree: AstReply, target: ClipboardTarget) {
    const owners = annotationOwners(tree);
    if (target.category === "annotations") {
        const owner = owners.find(owner => same(owner, target));
        if (owner) return { span: { start: owner.annotations[0]?.start ?? owner.start,
            end: owner.annotations[owner.annotations.length - 1]?.end ?? owner.start }, annotations: owner.annotations };
    }
    if (target.category === "annotation") {
        const annotation = owners.flatMap(owner => owner.annotations).find(annotation => same(annotation, target));
        if (annotation) return { span: annotation, annotations: [annotation] };
    }
    let found: { span: SourceSpan; node?: AstNode; trailing?: boolean; attachments?: SourceSpan[] } | undefined;
    const visit = (node: AstNode) => {
        if (target.category === "node" && node !== tree.root && same(node, target) && (!target.kind || target.kind === node.kind)) {
            const annotations = owners.find(owner => same(owner, node))?.annotations ?? [];
            const attachments = [...node.comments ?? [], ...annotations];
            const written = replacementSpan(tree, node) ?? node;
            found ??= { node, attachments, span: { start: Math.min(written.start, ...attachments.map(c => c.start)),
                end: Math.max(written.end, ...attachments.map(c => c.end)) } };
        }
        if (target.category === "comment") {
            const comment = commentBlocks(tree.source, node).find(comment => same(comment, target));
            if (comment) found = { span: comment, trailing: comment.start >= node.end &&
                !/[\r\n]/.test(tree.source.slice(node.end, comment.start)) };
        }
        if (node.kind !== "disabled") Object.entries(node.fields ?? {}).filter(([field]) => field !== "annotations")
            .forEach(([, children]) => (Array.isArray(children) ? children : [children]).forEach(visit));
    };
    visit(tree.root); return found;
}

function isStatement(tree: AstReply, node: AstNode) {
    const selected = selection(tree, { ...node, category: "node", kind: undefined });
    return selected && "node" in selected && selected.node === node && statementSites(tree).some(site => same(site, node));
}

export function copyGraphFragment(tree: AstReply, target: ClipboardTarget): ClipboardFragment | undefined {
    const selected = selection(tree, target);
    if (!selected) return undefined;
    const category = target.category === "annotations" ? "annotation" : target.category;
    let text = "annotations" in selected ? selected.annotations.map(annotation => tree.source.slice(annotation.start, annotation.end)).join("\n")
        : tree.source.slice(selected.span.start, selected.span.end);
    if ("node" in selected && selected.node) {
        // List separators belong to the destination list, not to the copied declaration.
        const excluded = [...syntaxTokens(tree.source, selected.node.end, selected.span.end).filter(t => [",", ";"].includes(t.text)),
            ...annotationOwners(tree).flatMap(o => o.annotations).filter(a => a.start >= selected.span.start && a.end <= selected.node!.start &&
                !selected.attachments?.some(attached => same(attached, a)))];
        for (const token of excluded.sort((a, b) => b.start - a.start)) {
            const at = token.start - selected.span.start;
            text = text.slice(0, at) + text.slice(at + token.end - token.start);
        }
    }
    return text ? { text, category, indent: indentAt(tree.source, selected.span.start),
        statement: "node" in selected && !!selected.node && isStatement(tree, selected.node) } : undefined;
}

export function externalGraphFragment(text: string): ClipboardFragment {
    const annotations = annotationOwners({ source: text, root: { kind: "block", start: 0, end: text.length, line: 1, column: 1 } })[0].annotations;
    const annotation = annotations.length > 0 && annotations.every(a => validAnnotation(a.text)) &&
        !syntaxTokens(text, annotations[annotations.length - 1].end).length;
    return { text, indent: "", category: annotation ? "annotation"
        : text.trimStart().startsWith("#") && !text.trimStart().startsWith("#[~") && !syntaxTokens(text).length ? "comment" : "node" };
}

export function cutGraphFragment(tree: AstReply, target: ClipboardTarget): SourceEdit | undefined {
    const selected = selection(tree, target);
    if (!selected) return undefined;
    if (target.category === "comment") return editComment(tree, target, "remove");
    if ("annotations" in selected) return { ...selected.span, text: tree.source.slice(selected.span.start, selected.span.end)
        .split("").filter((_, index) => !selected.annotations.some(annotation => index + selected.span.start >= annotation.start && index + selected.span.start < annotation.end)).join("") };
    const node = selected.node;
    if (!node) return undefined;
    const site = deleteSites(tree).find(site => same(site, node));
    const base = site ? deleteFromGraph(tree, site) : { ...replacementSpan(tree, node) ?? node,
        text: node.kind === "block" ? "{}" : node.kind.startsWith("type-") ? "any^" : "nil^" };
    if (!base) return undefined;
    let start = Math.min(base.start, selected.span.start), end = Math.max(base.end, selected.span.end);
    let text = tree.source.slice(start, base.start) + base.text + tree.source.slice(base.end, end);
    for (const attached of selected.attachments ?? []) text = text.replace(tree.source.slice(attached.start, attached.end), "");
    if (!text.trim()) {
        const line = tree.source.lastIndexOf("\n", start - 1) + 1, next = tree.source.indexOf("\n", end);
        if (!tree.source.slice(line, start).trim() && !tree.source.slice(end, next < 0 ? tree.source.length : next).trim()) {
            start = line; end = next < 0 ? tree.source.length : next + 1; text = "";
        }
    }
    return { start, end, text };
}

/** Reindent code lines without changing the bytes inside multiline string tokens. */
function format(fragment: ClipboardFragment, indent: string, newline: string) {
    const tokens = syntaxTokens(fragment.text), lines = fragment.text.split(/(\r\n|\n|\r)/);
    let at = 0;
    return lines.map((line, index) => {
        const protectedText = tokens.some(token => token.start < at && at < token.end);
        at += line.length;
        if (index % 2) return protectedText ? line : newline;
        return index && !protectedText ? indent + (line.startsWith(fragment.indent) ? line.slice(fragment.indent.length) : line) : line;
    }).join("");
}

function separator(text: string, token: string) {
    const tokens = syntaxTokens(text), last = tokens[tokens.length - 1];
    return last ? text.slice(0, last.end) + token + text.slice(last.end) : text;
}

/** A line comment would swallow another postfix comment on the same line. */
function postfixComment(text: string) {
    if (text.startsWith("#[")) return text;
    if (text.includes("#[") || text.includes("]#")) return undefined;
    return `#[${text.split(/\r?\n/).map(line => line.trimStart().replace(/^#/, "")).join("\n")}]#`;
}

export function pasteGraphFragment(tree: AstReply, target: ClipboardTarget, fragment: ClipboardFragment, insert: boolean): SourceEdit | undefined {
    const selected = selection(tree, target);
    if (!selected || !fragment.text.trim()) return undefined;
    const newline = tree.source.includes("\r\n") ? "\r\n" : "\n";
    const indent = indentAt(tree.source, selected.span.start), text = format(fragment, indent, newline);
    if (target.category !== "node") {
        if (fragment.category !== (target.category === "comment" ? "comment" : "annotation")) return undefined;
        const after = "trailing" in selected && selected.trailing;
        if (!insert && target.category !== "annotations") {
            const replacement = after && /[\r\n]/.test(text) ? postfixComment(text) : text;
            return replacement === undefined ? undefined : { ...selected.span, text: replacement };
        }
        if (after) {
            const original = postfixComment(tree.source.slice(selected.span.start, selected.span.end)), added = postfixComment(text);
            return original && added ? { ...selected.span, text: `${original} ${added}` } : undefined;
        }
        const at = selected.span.start;
        return { start: at, end: at, text: text + newline + indent };
    }
    const node = "node" in selected ? selected.node : undefined;
    if (!node) return undefined;
    if (fragment.category !== "node") {
        const owner = fragment.category === "annotation" && annotationOwners(tree).find(owner => same(owner, node));
        if (fragment.category === "annotation" && !owner) return undefined;
        const at = owner ? owner.annotations[0]?.start ?? node.start : selected.span.start;
        const prefix = tree.source.slice(tree.source.lastIndexOf("\n", at - 1) + 1, at);
        return { start: at, end: at, text: `${prefix.trim() ? newline + indent : ""}${text}${newline}${indent}` };
    }
    const statement = isStatement(tree, node);
    if (fragment.statement && !statement) return undefined;
    if (!insert) {
        const list = commaLists(tree).find(list => list.items.some(item => same(item, node)));
        const wrap = !statement && !["member", "parameter", "name", "type", "enum", "error"].includes(list?.mode ?? "") && !node.kind.startsWith("type-");
        let replacement = wrap ? `(${newline}${indent}${text}${newline}${indent})` : text;
        for (const token of syntaxTokens(tree.source, node.end, selected.span.end).filter(t => [",", ";"].includes(t.text)))
            replacement = separator(replacement, token.text);
        return { ...selected.span, text: replacement };
    }
    if (statement) {
        const at = selected.span.end;
        const semicolon = syntaxTokens(tree.source, at)[0];
        const end = semicolon?.text === ";" ? semicolon.end : at;
        return { start: end, end, text: newline + indent + text + newline + indent };
    }
    const list = commaLists(tree).find(list => !list.implicit && list.items.some(item => same(item, node)));
    if (!list || list.field === "return_type") return undefined;
    if (list.groupOnInsert) return { start: list.start, end: list.end,
        text: `(${tree.source.slice(list.start, list.end)},${newline}${indent}${text}${newline}${indent})` };
    if (["define", "reassign"].includes(list.node.kind)) {
        const partner = commaLists(tree).find(other => other.node === list.node && other.field === (list.field === "values" ? "targets" : "values"));
        if (!partner || partner.items.length !== list.items.length) return undefined;
        const index = list.items.findIndex(item => same(item, node)) + 1;
        const edits = [insertAt(tree.source, list, index, text), insertAt(tree.source, partner, index, list.field === "values" ? "_^" : "nil^")];
        let replacement = tree.source.slice(list.node.start, list.node.end);
        for (const edit of edits.sort((a, b) => b.start - a.start))
            replacement = replacement.slice(0, edit.start - list.node.start) + edit.text + replacement.slice(edit.end - list.node.start);
        return { start: list.node.start, end: list.node.end, text: replacement };
    }
    const trailing = syntaxTokens(tree.source, node.end, list.end);
    let writtenEnd = node.end;
    for (const token of trailing) {
        if (token.text !== ")") break;
        writtenEnd = token.end;
    }
    const comma = trailing.find(token => token.start >= writtenEnd);
    const at = Math.max(selected.span.end, writtenEnd);
    // A trailing comment may already include the separator in the copied extent.
    if (comma?.text === "," && comma.end <= at) return { start: at, end: at, text: newline + indent + separator(text, ",") + newline + indent };
    return { start: writtenEnd, end: at, text: `,${tree.source.slice(writtenEnd, at)}${newline}${indent}${text}${newline}${indent}` };
}
