import type { AstNode } from "./protocol";
import { syntaxTokens } from "./graphSyntax";

const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];

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
