import { forExpression } from "./graphLoops";
import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { syntaxTokens } from "./graphSyntax";
import { annotationOwners } from "./graphAnnotations";

export interface StatementSite extends SourceSpan { disabled: boolean }
export interface StatementInsertion extends SourceSpan {
    kind: string;
    field: string;
    /** Absent means append to this statement list. */
    before?: number;
}
export interface StatementTemplate { id: string; label: string; text: string; input?: { value: string; kind?: "count"; prefix?: string; suffix?: string } }
export const STATEMENT_TEMPLATE_LABELS = {
    let: "Variable Definition", var: "Mutable Variable Definition",
    function: "Function definition", procedure: "Procedure definition",
    if: "Conditional statement", repeat: "Repeat statement", for: "Counting loop", block: "Scoped block",
    return: "Return statement", break: "Exit loop", next: "Next iteration", panic: "Panic statement",
    match: "Pattern matching statement", comment: "Comment", call: "Call statement", assign: "Assignment statement", with: "Resource block",
    handled: "Exception handling block", yield: "Yield statement", await: "Await statement",
    type: "Type definition", tableDefinition: "Table definition", enumeration: "Enumeration definition",
    error: "Error definition", module: "Module declaration", import: "Import module", require: "Require file",
    focusedIf: "Condition with a local value",
} as const;
interface Context { callable?: "function" | "procedure"; loop: boolean }
interface StatementList {
    node: AstNode; field: string; items: AstNode[]; context: Context;
    emptyAt?: number;
}

function mainHeading(source: string, node: AstNode): number | undefined {
    if (node.kind !== "block") return;
    const tokens = syntaxTokens(source, node.start, node.end);
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].text === "{") depth++;
        else if (tokens[i].text === "}") depth--;
        else if (depth === 1 && tokens[i].text === "main^" && tokens[i + 1]?.text === ":") return tokens[i + 1].end;
    }
}

/** Only parser-owned statement lists are insertion sites, never expression/member lists. */
function lists(tree: AstReply): StatementList[] {
    const result: StatementList[] = [];
    const visit = (node: AstNode, context: Context, parent?: AstNode) => {
        if (node.kind === "disabled") return;
        if (node.kind === "func") context = {
            callable: tree.source.slice(node.start, node.end).trimStart().startsWith("p^") ? "procedure" : "function",
            loop: false,
        };
        if (node.kind === "repeat" || (node.kind === "for" &&
            (node.fields?.body as AstNode | undefined)?.kind === "block" && !forExpression(node, tree.source))) {
            context = { ...context, loop: true };
        }
        const field = node.kind === "block" ? "items" : node.kind === "loop-clause" ? "body" : undefined;
        if (field) {
            const value = node.fields?.[field];
            const items = Array.isArray(value) ? value : value ? [value] : [];
            let emptyAt: number | undefined;
            if (!items.length && parent?.kind === "if-clause") {
                const condition = parent.fields?.condition;
                const start = condition && !Array.isArray(condition) ? condition.end : parent.start;
                const marker = syntaxTokens(tree.source, start, parent.end).find(t => ["{", ":"].includes(t.text));
                if (marker) {
                    const comment = [...node.comments ?? [], ...parent.comments ?? []].find(c => c.start >= marker.end && !/[\r\n]/.test(tree.source.slice(marker.end, c.start)));
                    emptyAt = comment?.end ?? marker.end;
                }
            }
            result.push({ node, field, items, context, emptyAt });
        }
        for (const value of Object.values(node.fields ?? {})) {
            for (const child of Array.isArray(value) ? value : [value]) visit(child, context, node);
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
        const unnamedEmptyBody = node.kind === "block" && !items.length && (Array.isArray(extra) ? extra.length > 0 : !!extra)
            && mainHeading(tree.source, node) === undefined;
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
        template("match", "for^nil^ {\n    when^0:\n    other^:\n}"),
        template("comment", "# comment"),
        template("call", "print(nil^)"),
        template("assign", "value := 0"),
        template("panic", 'panic^ ""'),
        template("with", `with^ ${name("resource")} = nil^ {\n}`),
        template("handled", "do^{\ncatch^:\n}"),
        template("type", `let^ ${name("Type")} = t^{}`),
        template("tableDefinition", `let^ ${name("Item")} = def^{}`),
        template("enumeration", `enum^ ${name("Kind")} { Item }`),
        template("error", `errordef^ ${name("Problem")} { Failure }`),
        template("focusedIf", `for^let^${name("value")} = 0 if^true^ {\n}`),
    ];
    if (list.context.callable === "procedure") choices.push(template("yield", "yield^ 0"), template("await", "await^ nil^"));
    if (list.node === tree.root) {
        choices.push(template("import", "import^std.io"), template("require", 'require^"./module.lh"'));
        if (!list.items.some(item => item.kind === "module") && (!list.items.length || site.before === list.items[0].start))
            choices.push(template("module", `module^${name("example")}`));
    }
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
    const annotations = before && annotationOwners(tree).find(owner => owner.target !== "unit" && owner.start === before.start && owner.end === before.end)?.annotations;
    const beforeStart = before && Math.min(before.start, ...(before.comments ?? []).map(comment => comment.start), ...(annotations ?? []).map(annotation => annotation.start));
    const extra = [list.node.fields?.extra, list.node.fields?.arms]
        .flatMap(value => Array.isArray(value) ? value : value ? [value] : [])
        .sort((a, b) => a.start - b.start);
    const lastItemEnd = list.items[list.items.length - 1]?.end ?? list.node.start;
    const main = mainHeading(source, list.node);
    const firstExtra = extra.find(clause => clause.start >= (!list.items.length && main !== undefined ? main : lastItemEnd));
    const file = list.node === tree.root && tree.root.kind === "block";
    const closes = !file && list.node.kind === "block" && source[list.node.end - 1] === "}";
    let offset = beforeStart ?? list.emptyAt ?? firstExtra?.start ?? (file ? source.length : list.node.end - (closes ? 1 : 0));
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
