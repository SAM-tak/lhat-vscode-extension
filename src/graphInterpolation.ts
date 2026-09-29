import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { literalOf } from "./webview/literals";

export interface InterpolationSite extends SourceSpan {
    field: "text" | "format" | "expression" | "append";
    part?: SourceSpan;
}
export interface InterpolationField { site: InterpolationSite; value: string; compact?: boolean }
const one = (node: AstNode, field: string) => {
    const value = node.fields?.[field]; return Array.isArray(value) ? value[0] : value;
};
export const interpolationParts = (node: AstNode): AstNode[] => {
    const items = node.fields?.items; return Array.isArray(items) ? items : items ? [items] : [];
};

export function interpolationText(text: string): string | undefined {
    const quoted = `"${text.replace(/\{\{/g, "{").replace(/\}\}/g, "}")}"`;
    return literalOf({ kind: "string", start: 0, end: quoted.length, line: 1, column: 1 }, quoted)?.value;
}

export function interpolationFields(node: AstNode, source: string): InterpolationField[] {
    if (node.kind !== "interp" || !source.slice(node.start, node.end).startsWith('$"') || source[node.end - 1] !== '"') return [];
    const result: InterpolationField[] = [];
    const site = (field: InterpolationSite["field"], part?: AstNode): InterpolationSite => ({
        start: node.start, end: node.end, field, ...part ? { part: { start: part.start, end: part.end } } : {},
    });
    for (const part of interpolationParts(node)) {
        if (part.kind === "interp-text") {
            const value = interpolationText(source.slice(part.start, part.end));
            if (value !== undefined) result.push({ site: site("text", part), value });
        } else if (part.kind === "interp-hole") {
            const value = one(part, "value"), format = one(part, "format");
            if (value) result.push({ site: site("expression", part), value: source.slice(value.start, value.end) });
            result.push({ site: site("format", part), value: format ? source.slice(format.start + 1, format.end) : "" });
        }
    }
    result.push({ site: site("append"), value: "" });
    return result;
}

function encodeText(value: string): string {
    return value.replace(/[\\"{}\x00-\x1f\x7f]/g, character => ({
        "\\": "\\\\", '"': '\\"', "{": "{{", "}": "}}", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\0",
    }[character] ?? `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`));
}

/** Re-derive every editable field from the current AST; never accept an arbitrary range. */
export function editInterpolation(tree: AstReply, site: InterpolationSite, value: string): SourceEdit | undefined {
    let owner: AstNode | undefined;
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (node.kind === "interp" && node.start === site.start && node.end === site.end) owner = node;
        for (const child of Object.values(node.fields ?? {}).flat()) visit(child);
    };
    visit(tree.root);
    if (!owner || typeof value !== "string") return undefined;
    const field = interpolationFields(owner, tree.source).find(field => field.site.field === site.field &&
        field.site.part?.start === site.part?.start && field.site.part?.end === site.part?.end);
    if (!field) return undefined;
    if (site.field === "append") return value === "text" || value === "expression"
        ? { start: owner.end - 1, end: owner.end - 1, text: value === "text" ? "text" : "{nil^}" } : undefined;
    const part = interpolationParts(owner).find(part => part.start === site.part?.start && part.end === site.part?.end)!;
    if (site.field === "text") return { start: part.start, end: part.end, text: encodeText(value) };
    if (site.field === "expression") {
        const expression = one(part, "value");
        return expression && value.trim() ? { start: expression.start, end: expression.end, text: value } : undefined;
    }
    if (value.includes("}")) return undefined; // A format is raw text, terminated by the hole's closing brace.
    const format = one(part, "format");
    if (!format && tree.source[part.end - 1] !== "}") return undefined;
    return { start: format?.start ?? part.end - 1, end: format?.end ?? part.end - 1, text: value ? `:${value}` : "" };
}
