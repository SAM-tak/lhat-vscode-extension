import type { AstNode, AstReply, SourceSpan } from "./protocol";

/** Match the compiler's source normalization, without changing the document. */
export const normalizedGraphSource = (source: string): string =>
    source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

/** Translate the server's LF offsets back into this exact editor snapshot. */
export function graphTreeForDocument(tree: AstReply, source: string): AstReply | undefined {
    if (tree.source === source) return tree;
    if (tree.source !== normalizedGraphSource(source)) return undefined;

    // Both strings use UTF-16 offsets. Each CRLF contributes one extra unit
    // in the document; a leading BOM was omitted by the compiler as well.
    const offsets = new Uint32Array(tree.source.length + 1);
    let documentOffset = source.startsWith("\uFEFF") ? 1 : 0;
    for (let i = 0; i < tree.source.length; i++) {
        offsets[i] = documentOffset;
        if (source[documentOffset++] === "\r" && source[documentOffset] === "\n") documentOffset++;
    }
    offsets[tree.source.length] = documentOffset;
    const span = <T extends SourceSpan>(value: T): T =>
        ({ ...value, start: offsets[value.start], end: offsets[value.end] });
    const node = (value: AstNode): AstNode => ({
        ...span(value),
        ...(value.comments ? { comments: value.comments.map(span) } : {}),
        ...(value.fields ? { fields: Object.fromEntries(Object.entries(value.fields).map(([key, child]) =>
            [key, Array.isArray(child) ? child.map(node) : node(child)])) } : {}),
    });
    return { ...tree, source, root: node(tree.root) };
}
