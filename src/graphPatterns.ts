import { validSymbolName } from "./graphNames";
import type { AstNode, AstReply, SourceSpan } from "./protocol";
import { syntaxTokens, type SyntaxToken } from "./graphSyntax";

export interface WrittenPatternList {
    clause: AstNode;
    condition: AstNode;
    node: AstNode;
    items: AstNode[];
}
const one = (node: AstNode, field: string) => {
    const value = node.fields?.[field]; return Array.isArray(value) ? value[0] : value;
};

/** Pattern predicates contain generated focus comparisons with overlapping spans.
 * Recover only written values; never expose those comparisons as editable code.
 */
export function patternLists(tree: AstReply): WrittenPatternList[] {
    const result: WrittenPatternList[] = [], source = tree.source;
    const topLevel = (tokens: SyntaxToken[]) => {
        let depth = 0;
        return tokens.filter(token => {
            if ([")", "]", "}"].includes(token.text)) depth--;
            const top = depth === 0;
            if (["(", "[", "{"].includes(token.text)) depth++;
            return top;
        });
    };
    const value = (condition: AstNode, span: SourceSpan): AstNode => {
        let found: AstNode | undefined, size = -1, literal = false;
        const visit = (node: AstNode) => {
            const left = one(node, "left"), right = one(node, "right");
            const text = source.slice(node.start, node.end);
            const operator = left && right && left.end <= right.start
                ? syntaxTokens(source, left.end, right.start).find(t => !["(", ")"].includes(t.text)) : undefined;
            const generated = node.kind === "binary" && (!operator || [",", ":", "to^", "downto^"].includes(operator.text))
                || node.kind === "ident" && !validSymbolName(text);
            const isLiteral = ["int", "float", "string", "bool", "nil", "hat-ident"].includes(node.kind);
            const width = node.end - node.start;
            if (!generated && node.start >= span.start && node.end <= span.end && width > 0 &&
                (width > size || width === size && (!literal || isLiteral))) {
                found = node; size = width; literal = isLiteral;
            }
            Object.values(node.fields ?? {}).flat().forEach(visit);
        };
        visit(condition);
        const covered = found && syntaxTokens(source, span.start, found.start).every(t => t.text === "(")
            && syntaxTokens(source, found.end, span.end).every(t => t.text === ")");
        return covered ? found! : { ...condition, ...span, kind: "pattern", fields: undefined };
    };
    const item = (condition: AstNode, tokens: SyntaxToken[]): AstNode => {
        const span = { start: tokens[0].start, end: tokens[tokens.length - 1].end };
        const range = topLevel(tokens).find(t => ["to^", "downto^"].includes(t.text));
        if (range) return { ...condition, ...span, kind: "pattern-range", fields: {
            lower: value(condition, { start: span.start, end: range.start }),
            upper: value(condition, { start: range.end, end: span.end }),
        } };
        if (tokens[0].text === "fits^") return { ...condition, ...span, kind: "pattern-type", fields: {
            type: value(condition, { start: tokens[0].end, end: span.end }),
        } };
        return value(condition, span);
    };
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        const body = node.kind === "for" && one(node, "body");
        if (body && ["if-stmt", "if-expr"].includes(body.kind)) {
            for (const clause of Object.values(body.fields ?? {}).flat()) {
                const condition = one(clause, "condition"), tokens = syntaxTokens(source, clause.start, clause.end);
                if (!condition || tokens[0]?.text !== "when^") continue;
                const colon = topLevel(tokens.slice(1)).find(t => t.text === ":");
                if (!colon) continue;
                const written = tokens.filter(t => t.start >= tokens[0].end && t.end <= colon.start);
                const separators = topLevel(written).filter(t => t.text === ",");
                const boundaries = [tokens[0].end, ...separators.map(t => t.end), colon.start];
                const items = boundaries.slice(1).map((end, index) => written.filter(t =>
                    t.start >= boundaries[index] && t.end <= end && t.text !== ",")).filter(part => part.length).map(part => item(condition, part));
                if (items.length) result.push({ clause, condition, items, node: {
                    ...condition, kind: "pattern-list", start: written[0].start, end: written[written.length - 1].end, fields: { items },
                } });
            }
        }
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root); return result;
}

export const patternExpressions = (node: AstNode): AstNode[] => ["pattern-range", "pattern-type"].includes(node.kind)
    ? Object.values(node.fields ?? {}).flat().flatMap(patternExpressions)
    : node.kind.startsWith("pattern") ? [] : [node];
