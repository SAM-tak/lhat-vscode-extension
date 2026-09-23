import type { AstNode, CallableInfo, CallableInput } from "./protocol";
import { resultTypes, syntaxTokens } from "./graphSyntax";

const nodes = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];

/** Only the first parameter of the resolved signature denotes a receiver.
 * Nested callback types and ordinary functions stored in members are not methods.
 */
export function takesSelf(signature: string | undefined): boolean {
    if (!signature) return false;
    const tokens = syntaxTokens(signature);
    let i = tokens[0]?.text === "closed^" ? 1 : 0;
    if (!["f^", "p^"].includes(tokens[i++]?.text)) return false;
    if (tokens[i]?.text === "mutable^") i++;
    return tokens[i]?.text === "self^" && [",", "->", ";"].includes(tokens[i + 1]?.text);
}

export interface CallReceiver {
    value?: AstNode;
    type?: string;
    implicit?: boolean;
    /** A bare method value receives self as its first written argument. */
    explicit: boolean;
    member?: AstNode;
}

export function callReceiver(node: AstNode, info = callInfo(node)): CallReceiver | undefined {
    const target = nodes(node.fields?.target)[0];
    if (!target) return undefined;
    if (info?.receiver !== undefined) {
        const receiver = info.receiver;
        if (receiver === null) return undefined;
        if (receiver.binding === "member") {
            if (target.kind !== "member") return undefined;
            const value = nodes(target.fields?.target)[0];
            return value ? { value, type: receiver.type, explicit: false,
                member: nodes(target.fields?.argument ?? target.fields?.key)[0] } : undefined;
        }
        if (receiver.binding === "implicit") return { type: receiver.type, explicit: false, implicit: true };
        return { value: nodes(node.fields?.argument)[0], type: receiver.type, explicit: true };
    }
    if (!takesSelf(info?.signature ?? target.inferredType) && info?.inputs[0]?.name !== "self^") return undefined;
    if (target.kind === "member") {
        const value = nodes(target.fields?.target)[0];
        if (!value) return undefined;
        return { value, explicit: false, member: nodes(target.fields?.argument ?? target.fields?.key)[0] };
    }
    // An implicit super^ receiver has no expression in the argument list.
    // Only use a written self slot for non-member calls.
    if (info?.inputs[0]?.name !== "self^") return undefined;
    return { value: nodes(node.fields?.argument)[0], explicit: true };
}

/** Older servers still provide types, but never invent declaration names from them. */
export function callInfo(node: AstNode): CallableInfo | undefined {
    if (node.callable) return node.callable;
    const target = nodes(node.fields?.target)[0];
    const text = target?.inferredType;
    if (!text) return undefined;
    const tokens = syntaxTokens(text);
    const last = tokens[tokens.length - 1];
    const first = tokens[0]?.text === "closed^" ? 1 : 0;
    if (!["f^", "p^"].includes(tokens[first]?.text) || last?.text !== ";") return undefined;
    let depth = 0, arrow: number | undefined;
    for (let i = first + 1; i < tokens.length - 1; i++) {
        const token = tokens[i];
        if (["(", "[", "{", "f^", "p^"].includes(token.text)) depth++;
        else if ([")", "]", "}", ";"].includes(token.text)) depth--;
        else if (token.text === "->" && depth === 0) { arrow = i; break; }
        else if (["&", "|"].includes(token.text) && depth === 0) return undefined;
    }
    const end = arrow === undefined ? last.start : tokens[arrow].start;
    const params = text.slice(tokens[first].end, end).trim();
    const inputs: CallableInput[] = [], info: CallableInfo = { inputs, outputs: [], signature: text };
    for (const [index, part] of (params ? resultTypes(params) : []).entries()) {
        if (index === 0 && takesSelf(text)) {
            if (target?.kind !== "member") inputs.push({ name: "self^", type: nodes(node.fields?.argument)[0]?.inferredType ?? "?" });
            continue;
        }
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
