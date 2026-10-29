import type { AstNode, AstReply } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { isNumberLiteral, literalOf, quoteString } from "./webview/literals";

/** Resolve the displayed literal again instead of accepting an arbitrary source range. */
export function editLiteral(tree: AstReply, key: string, value: string): SourceEdit | undefined {
    if (typeof value !== "string") return undefined;
    let change: SourceEdit | undefined;
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        const literal = literalOf(node, tree.source);
        if (literal?.key === key && (literal.kind === "string" || isNumberLiteral(value))) {
            change = { start: node.start, end: node.end,
                text: literal.kind === "string" ? quoteString(value, tree.source[node.start] === "'") : value };
        }
        for (const child of Object.values(node.fields ?? {}).flat()) visit(child);
    };
    visit(tree.root);
    return change;
}
