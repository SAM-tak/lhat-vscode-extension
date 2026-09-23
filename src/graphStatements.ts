import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";

export interface StatementSite extends SourceSpan { disabled: boolean }
export interface StatementInsertion extends SourceSpan {
    kind: string;
    field: string;
    /** Absent means append to this statement list. */
    before?: number;
}
export interface StatementTemplate { id: string; label: string; text: string }
export const STATEMENT_TEMPLATE_LABELS = {
    let: "Variable Definition", var: "Mutable Variable Definition",
    function: "Function definition", procedure: "Procedure definition",
    if: "Conditional statement", repeat: "Repeat statement", for: "Counting loop", block: "Scoped block",
    return: "Return statement", break: "Exit loop", next: "Next iteration",
} as const;
interface Context { callable?: "function" | "procedure"; loop: boolean }
interface StatementList {
    node: AstNode; field: string; items: AstNode[]; context: Context;
}

/** Only parser-owned statement lists are insertion sites, never expression/member lists. */
function lists(tree: AstReply): StatementList[] {
    const result: StatementList[] = [];
    const visit = (node: AstNode, context: Context) => {
        if (node.kind === "disabled") return;
        if (node.kind === "func") context = {
            callable: tree.source.slice(node.start, node.end).trimStart().startsWith("p^") ? "procedure" : "function",
            loop: false,
        };
        if (node.kind === "repeat" || (node.kind === "for" &&
            !["if-stmt", "if-expr"].includes((node.fields?.body as AstNode | undefined)?.kind ?? ""))) {
            context = { ...context, loop: true };
        }
        const field = node.kind === "block" ? "items" : node.kind === "loop-clause" ? "body" : undefined;
        if (field) {
            const value = node.fields?.[field];
            result.push({ node, field, items: Array.isArray(value) ? value : value ? [value] : [], context });
        }
        for (const value of Object.values(node.fields ?? {})) {
            for (const child of Array.isArray(value) ? value : [value]) visit(child, context);
        }
    };
    visit(tree.root, { loop: false });
    return result;
}

export function statementSites(tree: AstReply): StatementSite[] {
    return lists(tree).flatMap(list => list.items.map(node => ({
        start: node.start, end: node.end, disabled: node.kind === "disabled",
    })));
}

export function statementInsertions(tree: AstReply): StatementInsertion[] {
    return lists(tree).flatMap(({ node, field, items }) => {
        const base = { start: node.start, end: node.end, kind: node.kind, field };
        const extra = node.fields?.extra;
        // In an explicitly sectioned loop, an empty implicit main has no
        // source position. Its named clauses provide their own append sites.
        const unnamedEmptyBody = node.kind === "block" && !items.length && (Array.isArray(extra) ? extra.length > 0 : !!extra);
        return [...items.filter(item => item.kind !== "module").map(item => ({ ...base, before: item.start })),
            ...unnamedEmptyBody ? [] : [base]];
    });
}

const sameInsertion = (a: StatementInsertion, b: StatementInsertion) =>
    a.start === b.start && a.end === b.end && a.kind === b.kind && a.field === b.field && a.before === b.before;

export function statementTemplates(tree: AstReply, site: StatementInsertion): StatementTemplate[] {
    if (!statementInsertions(tree).some(candidate => sameInsertion(candidate, site))) return [];
    const list = lists(tree).find(list => list.node.start === site.start && list.node.end === site.end &&
        list.node.kind === site.kind && list.field === site.field)!;
    const used = new Set<string>();
    const names = (node: AstNode) => {
        if (node.kind === "ident") used.add(tree.source.slice(node.start, node.end));
        for (const value of Object.values(node.fields ?? {})) {
            for (const child of Array.isArray(value) ? value : [value]) names(child);
        }
    };
    names(tree.root);
    const name = (base: string) => {
        let next = base, i = 2;
        while (used.has(next)) next = `${base}${i++}`;
        return next;
    };
    const template = (id: keyof typeof STATEMENT_TEMPLATE_LABELS, text: string): StatementTemplate =>
        ({ id, label: STATEMENT_TEMPLATE_LABELS[id], text });
    const choices = [
        template("let", `let^ ${name("value")} = 0`),
        template("var", `var^ ${name("value")} = 0`),
        template("function", `let^ ${name("function")} = f^{\n    return^ 0\n}`),
        template("procedure", `let^ ${name("procedure")} = p^{\n}`),
        template("if", "if^ true^ {\n}"),
        template("repeat", "repeat^ 1 {\n}"),
        template("for", `for^ ${name("i")} from^ 1 to^ 10 {\n}`),
        template("block", "do^{\n}"),
        template("return", list.context.callable === "procedure" ? "return^" : "return^ 0"),
    ];
    if (list.context.loop) choices.push(template("break", "break^"), template("next", "next^"));
    return choices;
}

/** Insert a complete template while retaining all existing text and its newline style. */
export function insertStatementEdit(tree: AstReply, site: StatementInsertion, template: string): SourceEdit | undefined {
    const choice = statementTemplates(tree, site).find(choice => choice.id === template);
    if (!choice) return undefined;
    const list = lists(tree).find(list => list.node.start === site.start && list.node.end === site.end &&
        list.node.kind === site.kind && list.field === site.field)!;
    const source = tree.source, newline = source.includes("\r\n") ? "\r\n" : "\n";
    const lineStart = (offset: number) => offset <= 0 ? 0 : source.lastIndexOf("\n", offset - 1) + 1;
    const indentation = (offset: number) => /^[\t ]*/.exec(source.slice(lineStart(offset), offset))![0];
    const before = list.items.find(item => item.start === site.before);
    const extra = [list.node.fields?.extra, list.node.fields?.arms]
        .flatMap(value => Array.isArray(value) ? value : value ? [value] : [])
        .sort((a, b) => a.start - b.start);
    const lastItemEnd = list.items[list.items.length - 1]?.end ?? list.node.start;
    const firstExtra = (Array.isArray(extra) ? extra : extra ? [extra] : []).find(clause => clause.start >= lastItemEnd);
    const file = list.node === tree.root && tree.root.kind === "block";
    const closes = !file && list.node.kind === "block" && source[list.node.end - 1] === "}";
    let offset = before?.start ?? firstExtra?.start ?? (file ? source.length : list.node.end - (closes ? 1 : 0));
    const baseIndent = indentation(list.node.start);
    const sibling = before ?? list.items[0];
    const inline = sibling && !/^[\t ]*$/.test(source.slice(lineStart(sibling.start), sibling.start));
    const indent = sibling && !inline ? indentation(sibling.start) : file ? "" : baseIndent + "    ";
    const text = choice.text.split("\n").map(line => indent + line).join(newline);
    const prefix = source.slice(lineStart(offset), offset);
    if (/^[\t ]*$/.test(prefix)) {
        offset = lineStart(offset);
        return { start: offset, end: offset, text: text + newline };
    }
    return { start: offset, end: offset, text: newline + text + newline + (before ? indent : closes ? baseIndent : "") };
}
