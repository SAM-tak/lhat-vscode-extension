import type { AstNode, CallableInfo, CallableInput } from "./protocol";
import { resultTypes, syntaxTokens } from "./graphSyntax";
import { assignmentOperator, assignmentValues } from "./graphAssignments";

const nodes = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];

/** Locate only this access's punctuation, beyond any grouped target. */
export function accessOperator(node: AstNode, source: string) {
    const target = nodes(node.fields?.target)[0];
    const punctuation = node.kind === "member" ? "." : node.kind === "index" ? "[" : node.kind === "call" ? "(" : undefined;
    if (!target || !punctuation) return undefined;
    const tokens = syntaxTokens(source, target.end, node.end), index = tokens.findIndex(token => token.text === punctuation);
    if (index < 0) return undefined;
    return { delimiter: tokens[index], optional: tokens[index - 1]?.text === "?" ? tokens[index - 1] : undefined };
}

/** Only the first parameter of the resolved signature denotes a receiver.
 * Nested callback types and ordinary functions stored in members are not methods.
 */
export function takesSelf(signature: string | undefined): boolean {
    if (!signature) return false;
    const tokens = syntaxTokens(signature);
    let i = 0;
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

/** Keep alternative arities available while an overloaded call is being built. */
export function callSignatures(node: AstNode): CallableInfo[] {
    const current = callInfo(node), target = nodes(node.fields?.target)[0], text = target?.inferredType;
    const result = current ? [current] : [];
    if (!text || !target) return result;
    let depth = 0, start = 0;
    const parts: string[] = [];
    for (const token of syntaxTokens(text)) {
        if (token.text === "&" && depth === 0) { parts.push(text.slice(start, token.start)); start = token.end; }
        else if (["f^", "p^", "(", "[", "{"].includes(token.text)) depth++;
        else if ([";", ")", "]", "}"].includes(token.text)) depth--;
    }
    parts.push(text.slice(start));
    if (parts.length < 2) return result;
    for (const part of parts) {
        const alternative = callInfo({ ...node, callable: undefined, inferredType: undefined,
            fields: { ...node.fields, target: { ...target, inferredType: part.trim() } } });
        if (alternative && !result.some(info => info.signature === alternative.signature))
            result.push({ ...alternative, receiver: current?.receiver ?? alternative.receiver });
    }
    return result;
}

/** A union covering a tuple is one unresolved alternative, never comma-split. */
export function outputTypes(type: string | undefined): string[] {
    return resultTypes(type);
}

export function hasCallInitializer(node: AstNode, source?: string): boolean {
    const values = bindingValues(node, source);
    const hasCall = (value: AstNode): boolean => value.kind === "call" ||
        (value.kind !== "func" && Object.values(value.fields ?? {}).flat().some(hasCall));
    return values.some(hasCall);
}

/** Binding pairs are editable only when each written value owns one position. */
export function canInsertBinding(node: AstNode, source?: string): boolean {
    const targets = nodes(node.fields?.targets), values = bindingValues(node, source);
    return (node.kind === "define" || node.kind === "reassign" && source !== undefined && !!assignmentOperator(node, source)) &&
        targets.length > 0 && targets.length === values.length && !hasCallInitializer(node, source) &&
        values.every(value => value.kind !== "tuple" && outputTypes(value.inferredType).length === 1);
}

/** An explicit tuple initializer can be edited as pairs without unpacking a call. */
export function bindingValues(node: AstNode, source?: string): AstNode[] {
    const values = node.kind === "reassign" && source !== undefined ? assignmentValues(node, source) : nodes(node.fields?.values);
    const unpack = node.kind !== "reassign" || source !== undefined && assignmentOperator(node, source)?.base === ":=";
    return unpack && nodes(node.fields?.targets).length > 1 && values.length === 1 && values[0].kind === "tuple"
        ? nodes(values[0].fields?.items) : values;
}
