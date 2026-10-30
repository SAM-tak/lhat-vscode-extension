import { sourceNames } from "./graphNames";
import type { AstNode } from "./protocol";
import { syntaxTokens } from "./graphSyntax";

const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];

/** The parser's unnamed focus binding has no written declaration or target. */
export function anonymousFocusValue(node: AstNode): AstNode | undefined {
    const targets = array(node.fields?.targets), values = array(node.fields?.values);
    return node.kind === "define" && targets.length === 1 && targets[0].kind === "focus (it^)" && values.length === 1 ? values[0] : undefined;
}

/** Single iterator names are wrapped in an implicit focus binding by the parser. */
export function iteratorNames(node: AstNode, source: string): AstNode[] {
    const bound = array(node.fields?.bound)[0];
    if (node.kind !== "for" || !bound) return [];
    let depth = 0, iterator = false;
    for (const token of syntaxTokens(source, node.start, bound.start)) {
        if ([")", "]", "}"].includes(token.text)) depth--;
        if (!depth && token.text === "in^") iterator = true;
        if (["(", "[", "{"].includes(token.text)) depth++;
    }
    if (!iterator) return [];
    const focus = array(node.fields?.focus);
    const names = focus.length === 1 && focus[0].kind === "define" ? array(focus[0].fields?.values) : focus;
    return names.map(name => array(name.fields?.name)[0] ?? name).filter(name => name.kind === "ident");
}

/** A focus chain takes its expression/statement form from its driving clause. */
export function forExpression(node: AstNode, source: string): boolean {
    if (node.kind !== "for") return false;
    const body = array(node.fields?.body)[0];
    if (!body) return false;
    return body.kind === "for" ? forExpression(body, source)
        : body.kind === "if-expr" || !node.fields?.bound &&
            syntaxTokens(source, array(node.fields?.focus).slice(-1)[0]?.end ?? node.start, body.start).some(token => token.text === "do^");
}

/** Wrapping a scope must not capture any existing reference. */
export function freshFocus(source: string): string {
    const used = sourceNames(source);
    let name = "local", index = 2;
    while (used.has(name)) name = `local${index++}`;
    return name;
}
