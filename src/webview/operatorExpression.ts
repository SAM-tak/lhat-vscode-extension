import type { AstNode } from "../protocol";
import { syntaxTokens, type SyntaxToken } from "../graphSyntax";
import { literalOf } from "./literals";

export type ExpressionCell = { operand: AstNode; inline: boolean } | { token: SyntaxToken; delimiter?: boolean };
const operation = (node: AstNode) => ["binary", "unary", "compare-chain"].includes(node.kind);
/** The same literal/name rule is shared by operator operands and method Self. */
export const isInlineValue = (node: AstNode, source: string): boolean =>
    !!literalOf(node, source) || ((["ident", "hat-ident", "bool", "bool-literal"].includes(node.kind) || dottedName(node, source)) &&
        syntaxTokens(source, node.start, node.end)[0]?.text !== "(");
const one = (node: AstNode, field: string) => {
    const value = node.fields?.[field]; return Array.isArray(value) ? value[0] : value;
};
/** A name path is one reference; calls, indexes and computed keys are values
 * in their own right. Inspect the gap too: grouping may lie outside AST spans.
 */
function dottedName(node: AstNode, source: string): boolean {
    if (["ident", "hat-ident"].includes(node.kind)) return true;
    if (node.kind !== "member" || node.computed) return false;
    const target = one(node, "target"), key = one(node, "argument") ?? one(node, "key");
    if (!target || !key || !["ident", "hat-ident", "int"].includes(key.kind) || !dottedName(target, source)) return false;
    const gap = syntaxTokens(source, target.end, key.start);
    return syntaxTokens(source, node.start, target.start).length === 0 && gap.length === 1 && gap[0].text === ".";
}
const closingParen = (tokens: SyntaxToken[]) => {
    let depth = 0;
    return tokens.findIndex(token => {
        if (token.text === "(") depth++;
        if (token.text === ")") depth--;
        return depth === 0;
    });
};

/** Flatten presentation only, preserving written grouping and operand order.
 * Parentheses may be outside an operand's AST span; inspect lexical gaps too.
 */
export function expressionCells(node: AstNode, source: string): ExpressionCell[] {
    let tokens = syntaxTokens(source, node.start, node.end);
    while (tokens[0]?.text === "(" && tokens[tokens.length - 1]?.text === ")") {
        const close = closingParen(tokens);
        if (close !== tokens.length - 1) break;
        tokens = tokens.slice(1, -1);
    }
    const start = tokens[0]?.start ?? node.start;
    const operand = (child: AstNode, flatten = true): ExpressionCell[] => {
        const before = syntaxTokens(source, start, child.start);
        const own = syntaxTokens(source, child.start, child.end);
        const after = tokens.find(token => token.start >= child.end);
        const ownGroup = own[0]?.text === "(" && (closingParen(own) < 0 || closingParen(own) === own.length - 1);
        const grouped = before[before.length - 1]?.text === "(" || ownGroup || after?.text === ")";
        if (flatten && !grouped && operation(child) && !literalOf(child, source)) {
            const cells = expressionCells(child, source);
            if (cells.length) return cells;
        }
        return [{ operand: child, inline: !grouped && isInlineValue(child, source) }];
    };
    if (node.kind === "index") {
        const target = one(node, "target"), argument = node.fields?.argument;
        if (!target) return [];
        const values = Array.isArray(argument) ? argument : argument ? [argument] : [];
        const at = tokens.findIndex(token => token.start >= target.end && token.text === "[");
        const open = tokens[at], close = tokens[tokens.length - 1];
        if (!open || close?.text !== "]") return [];
        const optional = tokens[at - 1]?.text === "?" ? tokens[at - 1] : undefined;
        const cells: ExpressionCell[] = [...operand(target, false), {
            token: optional ? { start: optional.start, end: open.end, text: "?[" } : open, delimiter: true,
        }];
        values.forEach((value, i) => {
            if (i) {
                const comma = tokens.find(token => token.start >= values[i - 1].end && token.end <= value.start && token.text === ",");
                if (comma) cells.push({ token: comma, delimiter: true });
            }
            // An index is one value, not another operator spine in this row.
            cells.push(...operand(value, false));
        });
        cells.push({ token: close, delimiter: true });
        return cells;
    }
    if (node.kind === "unary") {
        const value = one(node, "value") ?? one(node, "operand");
        if (!value) return [];
        const prefix = tokens.filter(token => token.end <= value.start && token.text !== "(");
        return [...prefix.map(token => ({ token })), ...operand(value)];
    }
    const values = node.kind === "compare-chain" ? node.fields?.operands
        : [one(node, "left"), one(node, "right")].filter((value): value is AstNode => !!value);
    if (!Array.isArray(values) || values.length < 2) return [];
    const cells: ExpressionCell[] = [];
    values.forEach((value, i) => {
        if (i) {
            const token = tokens.find(token => token.start >= values[i - 1].end && token.end <= value.start && !["(", ")"].includes(token.text));
            if (token) cells.push({ token });
        }
        cells.push(...operand(value));
    });
    return cells;
}
