import type { AstNode, CallableInfo, CallableInput } from "./protocol";
import { resultTypes, syntaxTokens } from "./graphSyntax";

const nodes = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];

/** Older servers still provide types, but never invent declaration names from them. */
export function callInfo(node: AstNode): CallableInfo | undefined {
    if (node.callable) return node.callable;
    const target = nodes(node.fields?.target)[0];
    const text = target?.inferredType;
    if (!text) return undefined;
    const tokens = syntaxTokens(text);
    const last = tokens[tokens.length - 1];
    if (!["f^", "p^"].includes(tokens[0]?.text) || last?.text !== ";") return undefined;
    let depth = 0, arrow: number | undefined;
    for (let i = 1; i < tokens.length - 1; i++) {
        const token = tokens[i];
        if (["(", "[", "{", "f^", "p^"].includes(token.text)) depth++;
        else if ([")", "]", "}", ";"].includes(token.text)) depth--;
        else if (token.text === "->" && depth === 0) { arrow = i; break; }
        else if (["&", "|"].includes(token.text) && depth === 0) return undefined;
    }
    const end = arrow === undefined ? last.start : tokens[arrow].start;
    const params = text.slice(tokens[0].end, end).trim();
    const inputs: CallableInput[] = [], info: CallableInfo = { inputs, outputs: [], signature: text };
    for (const part of params ? resultTypes(params) : []) {
        if (part.startsWith("...")) info.variadic = { type: part.replace(/^\.\.\.\s*:\s*/, "") };
        else inputs.push({ type: part });
    }
    const answer = node.inferredType ?? (arrow === undefined ? "-" : text.slice(tokens[arrow].end, last.start).trim());
    info.outputs = outputTypes(answer);
    return info;
}

/** A union covering a tuple is one unresolved alternative, never comma-split. */
export function outputTypes(type: string | undefined): string[] {
    return resultTypes(type);
}

export function hasCallInitializer(node: AstNode): boolean {
    const values = nodes(node.fields?.values);
    const hasCall = (value: AstNode): boolean => value.kind === "call" ||
        (value.kind !== "func" && Object.values(value.fields ?? {}).flat().some(hasCall));
    return values.some(hasCall);
}

/** Binding pairs are editable only when each written value owns one position. */
export function canInsertBinding(node: AstNode): boolean {
    const targets = nodes(node.fields?.targets), values = bindingValues(node);
    return node.kind === "define" && targets.length > 0 && targets.length === values.length &&
        !hasCallInitializer(node) && values.every(value => value.kind !== "tuple" && outputTypes(value.inferredType).length === 1);
}

/** An explicit tuple initializer can be edited as pairs without unpacking a call. */
export function bindingValues(node: AstNode): AstNode[] {
    const values = nodes(node.fields?.values);
    return nodes(node.fields?.targets).length > 1 && values.length === 1 && values[0].kind === "tuple"
        ? nodes(values[0].fields?.items) : values;
}
