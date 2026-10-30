import type { AstNode, AstReply, SourceSpan } from "./protocol";
import { identifierWord, resultTypes, syntaxTokens } from "./graphSyntax";
import { anonymousFocusValue } from "./graphLoops";
import { validSymbolName } from "./graphNames";

export interface AnnotationSite extends SourceSpan { ownerStart: number; ownerEnd: number; ownerKind: string; text: string }
export interface AnnotationOwner extends SourceSpan { kind: string; canAdd: boolean; annotations: AnnotationSite[];
    target: "unit" | "binding" | "field" | "member"; public?: boolean }
export interface AnnotationChoice { name: string; module?: string; targets?: Record<string, boolean>;
    parameterTypes?: string[]; variadic?: boolean }

/** Identity for view-only annotation boxes; never serialized into source. */
export const annotationOwnerKey = (owner: SourceSpan & { kind: string }): string => `${owner.kind}:${owner.start}:${owner.end}`;
const annotationName = (text: string) => identifierWord(text)?.replace(/\^+$/, "");
const validAnnotationName = (text: string) => annotationName(text) === text;

export function annotationArguments(text: string): { name: string; arguments?: string } {
    const name = text.startsWith("@") ? annotationName(text.slice(1)) ?? "" : "";
    const open = text.indexOf("(");
    return { name, arguments: open < 0 ? undefined : text.slice(open + 1, text.lastIndexOf(")")) };
}

/** Source spans for individual arguments; quoted commas remain inside a value. */
export function annotationArgumentSpans(text: string): (SourceSpan & { text: string })[] {
    const open = text.indexOf("("), close = text.lastIndexOf(")");
    if (open < 0 || close < open) return [];
    const tokens = syntaxTokens(text, open + 1, close), result: (SourceSpan & { text: string })[] = [];
    let start = open + 1;
    for (const end of [...tokens.filter(token => token.text === ",").map(token => token.start), close]) {
        const value = tokens.filter(token => token.start >= start && token.end <= end);
        if (value.length) result.push({ start: value[0].start, end: value[value.length - 1].end,
            text: text.slice(value[0].start, value[value.length - 1].end) });
        start = end + 1;
    }
    return result;
}

export function parseAnnotationCatalog(value: unknown): AnnotationChoice[] {
    if (!value || typeof value !== "object" || !Array.isArray((value as { annotations?: unknown }).annotations)) return [];
    const choices: AnnotationChoice[] = [];
    for (const entry of (value as { annotations: unknown[] }).annotations) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.name !== "string" || !validAnnotationName(item.name) ||
            !item.targets || typeof item.targets !== "object") continue;
        const choice: AnnotationChoice = { name: item.name, module: typeof item.module === "string" ? item.module : undefined,
            targets: Object.fromEntries(Object.entries(item.targets).map(([k, v]) => [k, v === true])) };
        if (typeof item.signature === "string") {
            const tokens = syntaxTokens(item.signature), end = tokens.find(t => t.text === "->" || t.text === ";")?.start;
            if (["f^", "p^"].includes(tokens[0]?.text) && end !== undefined) {
                const params = item.signature.slice(tokens[0].end, end).trim();
                const types = params ? resultTypes(params) : [];
                choice.parameterTypes = types.filter(t => !t.startsWith("..."));
                choice.variadic = types.some(t => t.startsWith("..."));
            }
        }
        choices.push(choice);
    }
    return choices;
}

export function annotationChoicesForOwner(tree: AstReply, owner: AnnotationOwner, replacing?: AnnotationSite): AnnotationChoice[] {
    const choices: AnnotationChoice[] = tree.annotationChoices ?? [...new Map(annotationOwners(tree).flatMap(o => o.annotations)
        .map(a => { const name = annotationArguments(a.text).name; return [name, { name }] as const; })).values()];
    const used = owner.annotations.filter(a => a.start !== replacing?.start).map(a => annotationArguments(a.text).name);
    return choices.filter(c => !used.includes(c.name) && (!c.targets || c.targets[owner.target] ||
        (owner.target === "binding" && owner.public && c.targets.public))).sort((a, b) => a.name.localeCompare(b.name));
}

export function annotationChoiceText(choice: AnnotationChoice, current?: string): string {
    const previous = current && annotationArguments(current).arguments;
    if (!choice.parameterTypes) return `@${choice.name}${previous !== undefined ? `(${previous})` : ""}`;
    const types = choice.parameterTypes;
    if (!types.length && !choice.variadic) return `@${choice.name}`;
    const count = previous ? syntaxTokens(previous).filter(t => t.text === ",").length + 1 : 0;
    const args = previous !== undefined && (count === types.length || (choice.variadic && count >= types.length))
        ? previous : types.map(type => type.includes("number^") ? "0" : type.includes("bool^") ? "false^" : '""').join(", ");
    return `@${choice.name}(${args ?? ""})`;
}

/** Servers may omit annotation lists from their AST visitor. Recover only
 * standalone annotation tokens immediately preceding a supported declaration. */
export function annotationOwners(tree: AstReply): AnnotationOwner[] {
    const owners: AnnotationOwner[] = [];
    const literals: SourceSpan[] = [];
    const visit = (node: AstNode, parent?: AstNode) => {
        if (["string", "interp-text", "disabled"].includes(node.kind)) { literals.push(node); return; }
        const focus = anonymousFocusValue(node);
        if (focus) { visit(focus, node); return; }
        if (node === tree.root || (node.kind === "define" && !["for", "with"].includes(parent?.kind ?? "")) ||
            (node.kind === "table-entry" && ["self-table", "def"].includes(parent?.kind ?? "")))
            owners.push({ start: node.start, end: node.end, kind: node.kind, canAdd: true, annotations: [],
                target: node === tree.root ? "unit" : node.kind === "define" ? "binding" : parent?.kind === "def" ? "member" : "field",
                public: node.kind === "define" && /\bpublic\^/.test(tree.source.slice(node.start, Math.min(node.end, node.start + 40))) });
        for (const [field, value] of Object.entries(node.fields ?? {})) {
            if (field === "annotations") continue;
            for (const child of Array.isArray(value) ? value : [value]) visit(child, node);
        }
    };
    visit(tree.root);
    const tokens = syntaxTokens(tree.source).filter(t => !literals.some(span => t.start >= span.start && t.start < span.end));
    const atAnnotation = (i: number) => tokens[i]?.text === "@" &&
        validAnnotationName(tokens[i + 1]?.text ?? "") && tokens[i].end === tokens[i + 1].start;
    for (let i = 0; i < tokens.length; i++) {
        if (!atAnnotation(i)) continue;
        const first = i, spans: SourceSpan[] = [];
        while (atAnnotation(i)) {
            const start = tokens[i].start;
            i += 2;
            if (tokens[i]?.text === "(" && !/[\r\n]/.test(tree.source.slice(tokens[i - 1].end, tokens[i].start))) {
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
    const name = text.startsWith("@") && annotationName(text.slice(1));
    if (!name) return false;
    const suffix = text.slice(name.length + 1);
    const rest = suffix.trim();
    if (rest && /[\r\n]/.test(suffix.slice(0, suffix.indexOf("(")))) return false;
    if (!rest) return true;
    if (!rest.startsWith("(") || !rest.endsWith(")")) return false;
    const closing = syntaxTokens(rest).slice(-1)[0];
    if (closing?.text !== ")" || closing.end !== rest.length) return false;
    const body = rest.slice(1, -1);
    const literal = /^(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^']|'')*'|-?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?))$/u;
    const tokens = syntaxTokens(body);
    let from = 0;
    for (let i = 0; i <= tokens.length; i++) {
        if (i < tokens.length && tokens[i].text !== ",") continue;
        if (from === i) return i === tokens.length;
        const argument = body.slice(tokens[from].start, tokens[i - 1].end);
        if (!literal.test(argument) && !validSymbolName(argument)) return false;
        from = i + 1;
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
        const unit = owner.kind === tree.root.kind && owner.start === tree.root.start;
        const last = owner.annotations[owner.annotations.length - 1];
        // Append before the declaration, leaving existing annotations and their
        // trailing comments in their original order. Units precede the first code token.
        const insert = unit ? last ? syntaxTokens(tree.source, last.end)[0]?.start ?? tree.source.length
            : tree.source.startsWith("\uFEFF") ? 1 : 0 : owner.start;
        const newline = tree.source.includes("\r\n") ? "\r\n" : "\n";
        const line = tree.source.lastIndexOf("\n", insert - 1) + 1;
        const before = tree.source.slice(line, insert);
        const indent = /^[\t ]*$/.test(before) ? before : /^[\t ]*/.exec(before)![0];
        const prefix = before.trim() ? newline + indent : "";
        return { start: insert, end: insert, text: prefix + value + newline + indent };
    }
    const site = owner.annotations.find(a => a.start === request.start && a.end === request.end);
    if (!site) return;
    return { start: site.start, end: site.end, text: value };
}
