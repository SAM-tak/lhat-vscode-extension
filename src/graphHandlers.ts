import type { AstNode, AstReply } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import type { StatementTemplate } from "./graphStatements";
import { syntaxTokens } from "./graphSyntax";

import { validName, validMemberName, nameSegments } from "./graphNames";

const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];
const one = (node: AstNode, field: string) => array(node.fields?.[field])[0];

export function validCatchFilter(text: string): boolean {
    const separators = syntaxTokens(text).filter(token => token.text === "|");
    let from = 0;
    return [...separators, { start: text.length, end: text.length }].every(separator => {
        const path = nameSegments(text.slice(from, separator.start).trim());
        from = separator.end;
        return !!path && (validName(path[0]) || ["error^", "localerror^"].includes(path[0])) && path.slice(1).every(validMemberName);
    });
}

/** A handler belongs to a braced scope, never a branch's unbraced body. */
export function handlerActions(tree: AstReply, node: AstNode, parent?: AstNode): (StatementTemplate & { edit: SourceEdit })[] {
    const result: (StatementTemplate & { edit: SourceEdit })[] = [], source = tree.source;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const add = (id: string, label: string, edit: SourceEdit) => result.push({ id, label, text: edit.text || label, edit });
    if (parent && array(parent.fields?.arms).includes(node)) {
        const tokens = syntaxTokens(source, node.start, node.end), marker = tokens[0];
        const condition = one(node, "condition"), colon = tokens.find(t => t.text === ":" && t.start >= (condition?.end ?? marker.end));
        if (marker?.text !== "catch^" || !colon) return result;
        add("catch:filter", "Filter caught errors", { start: condition?.start ?? marker.end, end: condition?.end ?? marker.end, text: condition ? "error^" : " error^" });
        result[result.length - 1].input = { kind: "catchType", value: condition ? source.slice(condition.start, condition.end) : "error^", prefix: condition ? "" : " " };
        if (condition && array(parent.fields?.arms).slice(-1)[0] === node)
            add("catch:unfiltered", "Catch all remaining errors", { start: condition.start, end: condition.end, text: "" });
        return result;
    }
    const scope = ["func", "for", "repeat"].includes(node.kind) ? one(node, "body")
        : node.kind === "with" ? one(node, "extra") : ["block", "if-stmt"].includes(node.kind) ? node : undefined;
    if (!scope || node === tree.root || node.kind === "block" && parent?.kind === "if-clause") return result;
    const tokens = syntaxTokens(source, scope.start, scope.end), close = tokens.slice(-1)[0];
    if (close?.text !== "}" || !["{", "do^", "if^"].includes(tokens[0]?.text)) return result;
    const arms = array(scope.fields?.arms), extra = array(scope.fields?.extra);
    const trailing = extra.filter(clause => ["last^", "epilog^", "epilogue^", "finally^"].includes(syntaxTokens(source, clause.start, clause.end)[0]?.text));
    const end = Math.min(close.start, ...trailing.map(clause => clause.start));
    const bare = arms.find(arm => !one(arm, "condition"));
    const at = bare?.start ?? end;
    add("catch:add", "Add filtered catch", { start: at, end: at, text: `${newline}catch^error^:${newline}` });
    if (!bare) add("catch:all", "Add catch for remaining errors", { start: end, end, text: `${newline}catch^:${newline}` });
    arms.forEach((arm, index) => add(`remove-catch:${index}`, "Remove catch", {
        start: arm.start, end: arms[index + 1]?.start ?? end, text: "" }));
    const loopScope = ["for", "repeat"].includes(node.kind) || node.kind === "block" && parent && ["for", "repeat"].includes(parent.kind);
    if (!loopScope) {
        const final = extra.find(clause => syntaxTokens(source, clause.start, clause.end)[0]?.text === "finally^");
        if (final) add("remove-finally", "Remove finally section", { start: final.start, end: close.start, text: "" });
        else add("finally:add", "Add finally section", { start: close.start, end: close.start, text: `${newline}finally^:${newline}` });
    }
    return result;
}
