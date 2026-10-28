import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { StatementTemplate } from "./graphStatements";
import type { SourceEdit } from "./graphReorder";

export interface ExpressionSite extends SourceSpan { kind: string; assignmentTarget?: boolean; memberKey?: boolean }
const kinds = new Set(["int", "float", "string", "bool", "nil", "ident", "hat-ident", "hole",
    "binary", "unary", "call", "member", "index", "tuple", "table", "def", "self-table", "func", "interp", "if-expr"]);

/** Declaration names, type syntax and member keys are not replaceable value expressions. */
export function expressionSites(tree: AstReply): ExpressionSite[] {
    const sites: ExpressionSite[] = [];
    const visit = (node: AstNode, value = true, assignmentTarget = false, memberKey = false) => {
        if (["disabled", "module", "annotation", "import", "import-stmt", "require-stmt"].includes(node.kind) || node.kind.startsWith("type-")) return;
        if (value && kinds.has(node.kind) && node.start < node.end)
            sites.push({ kind: node.kind, start: node.start, end: node.end, ...assignmentTarget ? { assignmentTarget: true } : {}, ...memberKey ? { memberKey: true } : {} });
        for (const [field, children] of Object.entries(node.fields ?? {})) {
            const declaration = ["name", "key", "type", "return_type", "annotations"].includes(field)
                || node.kind === "define" && field === "targets"
                || node.kind === "func" && field === "params";
            for (const child of Array.isArray(children) ? children : [children]) {
                if (!declaration) visit(child, true, node.kind === "reassign" && field === "targets", node.kind === "member" && field === "argument" && !node.computed);
                else if (["param", "field", "member-decl"].includes(child.kind)) visit(child, false);
            }
        }
    };
    visit(tree.root);
    return sites;
}

export const validMember = (text: string) => /^(?:[\p{L}_][\p{L}\p{N}_]*\^?|[0-9]+)$/u.test(text);
export const validReference = (text: string) => /^(?:[\p{L}_][\p{L}\p{N}_]*|self\^|it\^)(?:\.(?:[\p{L}_][\p{L}\p{N}_]*\^?|[0-9]+))*$/u.test(text);

export function expressionTemplates(tree: AstReply, site: ExpressionSite): StatementTemplate[] {
    const currentSite = expressionSites(tree).find(s => s.kind === site.kind && s.start === site.start && s.end === site.end);
    if (!currentSite) return [];
    const current = tree.source.slice(site.start, site.end);
    const choices: [string, string, string][] = [
        ["match", "Pattern matching expression", "(for^nil^: when^0: 0 other^: 0;)"],
        ["number", "Number", "0"], ["string", "String", '""'], ["true", "True", "true^"],
        ["false", "False", "false^"], ["nil", "Nil", "nil^"], ["table", "Table", "{}"],
        ["function", "Function", "f^{ return^ 0 }"], ["procedure", "Procedure", "p^{}"],
        ["member", "Access a member", `(${current}).value`],
        ["call", "Call this value", `(${current})(nil^)`],
        ["index", "Index this value", `(${current})[0]`],
        ["add", "Add to this value", `((${current}) + 0)`],
        ["not", "Negate condition", `(!(${current}))`],
        ["negative", "Negate number", `(-(${current}))`],
    ];
    const references = new Set<string>(currentSite.memberKey ? ["value", "0"] : ["self^", "it^"]);
    const names = (node: AstNode) => {
        if (["ident", "hat-ident", "member"].includes(node.kind)) {
            const name = tree.source.slice(node.start, node.end);
            if ((currentSite.memberKey ? validMember : validReference)(name)) references.add(name);
        }
        for (const child of Object.values(node.fields ?? {}).flat()) names(child);
    };
    names(tree.root);
    return [...choices.filter(([id]) => !currentSite.memberKey && (!currentSite.assignmentTarget || ["index", "member"].includes(id))).map(([id, label, text]) => ({ id, label, text })),
        ...[...references].sort().map(name => ({ id: `reference:${name}`, label: name, text: name }))];
}

export function replaceExpression(tree: AstReply, site: ExpressionSite, template: string): SourceEdit | undefined {
    const choices = expressionTemplates(tree, site);
    if (!choices.length) return undefined;
    const name = template.startsWith("reference:") ? template.slice(10) : undefined;
    const currentSite = expressionSites(tree).find(s => s.kind === site.kind && s.start === site.start && s.end === site.end)!;
    const text = name !== undefined && (currentSite.memberKey ? validMember : validReference)(name) ? name : choices.find(c => c.id === template)?.text;
    return text === undefined ? undefined : { start: site.start, end: site.end, text };
}
