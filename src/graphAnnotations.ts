import type { AstNode, AstReply, SourceSpan } from "./protocol";
import { syntaxTokens } from "./graphSyntax";

export interface AnnotationSite extends SourceSpan { ownerStart: number; ownerEnd: number; ownerKind: string; text: string }
export interface AnnotationOwner extends SourceSpan { kind: string; canAdd: boolean; annotations: AnnotationSite[] }

/** Servers may omit annotation lists from their AST visitor. Recover only
 * standalone annotation tokens immediately preceding a supported declaration. */
export function annotationOwners(tree: AstReply): AnnotationOwner[] {
    const owners: AnnotationOwner[] = [];
    const literals: SourceSpan[] = [];
    const visit = (node: AstNode, parent?: AstNode) => {
        if (["string", "interp-text", "disabled"].includes(node.kind)) { literals.push(node); return; }
        if (node === tree.root || node.kind === "define" ||
            (node.kind === "table-entry" && ["self-table", "def"].includes(parent?.kind ?? "")))
            owners.push({ start: node.start, end: node.end, kind: node.kind, canAdd: true, annotations: [] });
        for (const [field, value] of Object.entries(node.fields ?? {})) {
            if (field === "annotations") continue;
            for (const child of Array.isArray(value) ? value : [value]) visit(child, node);
        }
    };
    visit(tree.root);
    const tokens = syntaxTokens(tree.source).filter(t => !literals.some(span => t.start >= span.start && t.start < span.end));
    const atAnnotation = (i: number) => tokens[i]?.text === "@" &&
        /^[\p{L}_][\p{L}\p{N}_]*$/u.test(tokens[i + 1]?.text ?? "") && tokens[i].end === tokens[i + 1].start;
    for (let i = 0; i < tokens.length; i++) {
        if (!atAnnotation(i)) continue;
        const first = i, spans: SourceSpan[] = [];
        while (atAnnotation(i)) {
            const start = tokens[i].start;
            i += 2;
            if (tokens[i]?.text === "(") {
                let depth = 0;
                do {
                    if (tokens[i].text === "(") depth++;
                    if (tokens[i].text === ")") depth--;
                    i++;
                } while (i < tokens.length && depth);
            }
            spans.push({ start, end: tokens[i - 1].end });
        }
        const owner = first === 0 ? owners[0] : owners.find(o => o.start === tokens[i]?.start);
        if (owner) for (const span of spans) owner.annotations.push({ ...span,
            ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, text: tree.source.slice(span.start, span.end) });
        i--;
    }
    // At the unit head the parser always consumes annotations for the unit.
    // Do not offer an operation that would silently annotate a different owner.
    const firstDeclarationToken = tokens.find(t => !owners[0].annotations.some(a => t.start >= a.start && t.end <= a.end));
    for (const owner of owners.slice(1)) if (owner.start === firstDeclarationToken?.start) owner.canAdd = false;
    return owners;
}

/** One complete annotation; delimiters inside quoted arguments are protected. */
export function validAnnotation(text: string): boolean {
    const name = /^@[\p{L}_][\p{L}\p{N}_]*/u.exec(text);
    if (!name) return false;
    const suffix = text.slice(name[0].length);
    const rest = suffix.trim();
    if (rest && /[\r\n]/.test(suffix.slice(0, suffix.indexOf("(")))) return false;
    if (!rest) return true;
    if (!rest.startsWith("(") || !rest.endsWith(")")) return false;
    const body = rest.slice(1, -1);
    const argument = /\s*(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|-?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)|[\p{L}_][\p{L}\p{N}_]*\^?)\s*(?:,|$)/uy;
    if (!body.trim()) return true;
    let at = 0;
    while (at < body.length) {
        argument.lastIndex = at;
        if (!argument.exec(body)) return false;
        at = argument.lastIndex;
        if (!body.slice(at).trim()) return true;
    }
    return true;
}

export function editAnnotation(tree: AstReply, request: SourceSpan & { ownerStart: number; ownerEnd: number; ownerKind: string; value: string; add?: boolean }): (SourceSpan & { text: string }) | undefined {
    const owner = annotationOwners(tree).find(o => o.start === request.ownerStart && o.end === request.ownerEnd && o.kind === request.ownerKind);
    if (!owner) return;
    const value = request.value.trim();
    if (value && !validAnnotation(value)) return;
    if (request.add) {
        if (!value || !owner.canAdd) return;
        const at = owner.annotations[0]?.start ?? owner.start;
        // The unit starts before its first token (and after a possible BOM).
        const insert = owner.kind === tree.root.kind && owner.start === tree.root.start ? (tree.source.startsWith("\uFEFF") ? 1 : 0) : at;
        const line = tree.source.lastIndexOf("\n", insert - 1) + 1;
        const indent = /^[\t ]*$/.test(tree.source.slice(line, insert)) ? tree.source.slice(line, insert) : "";
        return { start: insert, end: insert, text: value + (tree.source.includes("\r\n") ? "\r\n" : "\n") + indent };
    }
    const site = owner.annotations.find(a => a.start === request.start && a.end === request.end);
    if (!site) return;
    return { start: site.start, end: site.end, text: value };
}
