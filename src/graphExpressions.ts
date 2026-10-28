import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { StatementTemplate } from "./graphStatements";
import type { SourceEdit } from "./graphReorder";

export interface ExpressionSite extends SourceSpan { kind: string }
const kinds = new Set(["int", "float", "string", "bool", "nil", "ident", "hat-ident", "hole",
    "binary", "unary", "call", "member", "index", "tuple", "table", "def", "self-table", "func", "interp", "if-expr"]);

/** Declaration names, type syntax and member keys are not replaceable value expressions. */
export function expressionSites(tree: AstReply): ExpressionSite[] {
    const sites: ExpressionSite[] = [];
    const visit = (node: AstNode, value = true) => {
        if (["disabled", "module", "annotation", "import", "import-stmt", "require-stmt"].includes(node.kind) || node.kind.startsWith("type-")) return;
        if (value && kinds.has(node.kind) && node.start < node.end)
            sites.push({ kind: node.kind, start: node.start, end: node.end });
        for (const [field, children] of Object.entries(node.fields ?? {})) {
            const declaration = ["name", "key", "type", "return_type", "annotations"].includes(field)
                || ["define", "reassign"].includes(node.kind) && field === "targets"
                || node.kind === "member" && field === "argument"
                || node.kind === "func" && field === "params";
            for (const child of Array.isArray(children) ? children : [children]) {
                if (!declaration) visit(child, true);
                else if (["param", "field", "member-decl"].includes(child.kind)) visit(child, false);
            }
        }
    };
    visit(tree.root);
    return sites;
}

export const validReference = (text: string) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(text);

export function expressionTemplates(tree: AstReply, site: ExpressionSite): StatementTemplate[] {
    if (!expressionSites(tree).some(s => s.kind === site.kind && s.start === site.start && s.end === site.end)) return [];
    const current = tree.source.slice(site.start, site.end);
    const choices: [string, string, string][] = [
        ["number", "Number", "0"], ["string", "String", '""'], ["true", "True", "true^"],
        ["false", "False", "false^"], ["nil", "Nil", "nil^"], ["table", "Table", "{}"],
        ["function", "Function", "f^{ return^ 0 }"], ["procedure", "Procedure", "p^{}"],
        ["call", "Call this value", `(${current})(nil^)`],
        ["index", "Index this value", `(${current})[0]`],
        ["add", "Add to this value", `((${current}) + 0)`],
        ["not", "Negate condition", `(not^ (${current}))`],
        ["negative", "Negate number", `(-(${current}))`],
    ];
    const references = new Set<string>();
    const names = (node: AstNode) => {
        if (node.kind === "ident") {
            const name = tree.source.slice(node.start, node.end);
            if (validReference(name)) references.add(name);
        }
        for (const child of Object.values(node.fields ?? {}).flat()) names(child);
    };
    names(tree.root);
    return [...choices.map(([id, label, text]) => ({ id, label, text })),
        ...[...references].sort().map(name => ({ id: `reference:${name}`, label: name, text: name }))];
}

export function replaceExpression(tree: AstReply, site: ExpressionSite, template: string): SourceEdit | undefined {
    const choices = expressionTemplates(tree, site);
    if (!choices.length) return undefined;
    const name = template.startsWith("reference:") ? template.slice(10) : undefined;
    const text = name !== undefined && validReference(name) ? name : choices.find(c => c.id === template)?.text;
    return text === undefined ? undefined : { start: site.start, end: site.end, text };
}
