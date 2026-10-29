import type { AstNode, AstReply, SourceSpan } from "./protocol";
import { syntaxTokens } from "./graphSyntax";
import type { SourceEdit } from "./graphReorder";
import { literalOf, quoteString } from "./webview/literals";

export interface TextSite extends SourceSpan {
    field: "comment" | "module" | "import" | "require" | "name";
    part?: SourceSpan;
}
export interface TextField { site: TextSite; value: string; compact?: boolean }
export function textFields(tree: AstReply): TextField[] {
    const result: TextField[] = [];
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        for (const comment of node.comments ?? []) {
            const raw = tree.source.slice(comment.start, comment.end);
            if (raw.startsWith("#[~")) continue;
            result.push({ site: { start: comment.start, end: comment.end, field: "comment" },
                value: (comment.block ? raw.slice(2, -2) : raw.slice(1)).trim() });
        }
        if (node.kind === "name") {
            const name = syntaxTokens(tree.source, node.start, node.end)[1];
            if (name) result.push({ site: { start: node.start, end: node.end, field: "name", part: name }, value: name.text });
        }
        const kind = node.kind.replace(/-stmt$/, "");
        if (["module", "import", "require"].includes(kind)) {
            const children = node.fields?.[kind === "module" ? "name" : "value"];
            const value = Array.isArray(children) ? children[0] : children;
            if (value) {
                const text = kind === "require" ? literalOf(value, tree.source)?.value : tree.source.slice(value.start, value.end);
                if (text !== undefined) result.push({ site: { start: node.start, end: node.end,
                    field: kind as TextSite["field"], part: { start: value.start, end: value.end } }, value: text });
            }
            return;
        }
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root); return result;
}

export function editTextField(tree: AstReply, site: TextSite, value: string): SourceEdit | undefined {
    const field = textFields(tree).find(f => f.site.field === site.field && f.site.start === site.start && f.site.end === site.end);
    if (!field || typeof value !== "string") return undefined;
    const current = field.site;
    if (site.field === "comment") {
        const raw = tree.source.slice(current.start, current.end);
        const newline = tree.source.includes("\r\n") ? "\r\n" : "\n";
        if (raw.startsWith("#[")) {
            let depth = 0;
            for (const token of value.match(/#\[|\]#/g) ?? []) {
                depth += token === "#[" ? 1 : -1;
                if (depth < 0) return undefined;
            }
            if (depth !== 0 || value.trimStart().startsWith("~")) return undefined;
            return { start: current.start, end: current.end, text: `#[ ${value} ]#` };
        }
        return { start: current.start, end: current.end, text: value.split(/\r\n?|\n/).map(line => `# ${line}`).join(newline) };
    }
    if (site.field === "name") return /^[\p{L}_][\p{L}\p{N}_]*\^?$/u.test(value) ? { ...current.part!, text: value } : undefined;
    if (site.field !== "require" && !/^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(value)) return undefined;
    return { ...current.part!, text: site.field === "require" ? quoteString(value) : value };
}
