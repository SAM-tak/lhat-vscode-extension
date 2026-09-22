import type { AstNode } from "./protocol";
import { syntaxTokens, type SyntaxToken } from "./graphSyntax";

export const ASSIGNMENT_LABELS = {
    ":=": "Reassignment",
    "+=": "Addition Assignment",
    "-=": "Subtraction Assignment",
    "*=": "Multiplication Assignment",
    "/=": "Division Assignment",
    "%=": "Remainder Assignment",
    "//=": "Floor Division Assignment",
    "**=": "Exponentiation Assignment",
    "..=": "Concatenation Assignment",
} as const;
export type AssignmentOperator = keyof typeof ASSIGNMENT_LABELS;
const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];

export function assignmentOperator(node: AstNode, source: string): (SyntaxToken & { base: AssignmentOperator; nilChecked: boolean }) | undefined {
    if (node.kind !== "reassign") return;
    const targets = array(node.fields?.targets);
    for (const token of syntaxTokens(source, targets[targets.length - 1]?.end ?? node.start, node.end)) {
        const nilChecked = token.text.startsWith("?");
        const base = nilChecked ? token.text.slice(1) : token.text;
        if (Object.prototype.hasOwnProperty.call(ASSIGNMENT_LABELS, base)) return { ...token, base: base as AssignmentOperator, nilChecked };
    }
}

/** Some servers expose compound values as synthetic target-op-RHS trees.
 * Only peel that wrapper when its left span is the corresponding write target;
 * an ordinary binary expression written on the RHS must remain intact. */
export function assignmentValues(node: AstNode, source: string): AstNode[] {
    const operator = assignmentOperator(node, source), targets = array(node.fields?.targets);
    const values = array(node.fields?.values);
    if (!operator || operator.base === ":=") return values;
    return values.map((value, i) => {
        const left = array(value.fields?.left)[0], right = array(value.fields?.right)[0], target = targets[i];
        return value.kind === "binary" && target && left && right &&
            left.start === target.start && left.end === target.end && right.start >= operator.end
            ? right : value;
    });
}
