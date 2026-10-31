import type { GraphDiagnostic, SourceSpan } from "../protocol";

interface DiagnosticBox {
    id: string;
    data: { start?: number; sourceEnd?: number; layoutOnly?: boolean; scrollSurface?: boolean;
        isStart?: boolean; isAdd?: boolean; decoration?: boolean;
        annotationList?: { annotations: SourceSpan[] } };
}

/** Attach each error to the smallest visible box covering its written range. */
export function graphErrors(nodes: DiagnosticBox[], diagnostics: GraphDiagnostic[]): Record<string, string> {
    const boxes = nodes.flatMap(({ id, data }) => {
        if (data.isStart || data.isAdd || data.decoration || data.layoutOnly && !data.scrollSurface) return [];
        const annotations = data.annotationList?.annotations;
        const start = annotations ? Math.min(...annotations.map(a => a.start)) : data.start;
        const end = annotations ? Math.max(...annotations.map(a => a.end)) : data.sourceEnd;
        return start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && start <= end
            ? [{ id, start, end }] : [];
    });
    const messages: Record<string, Set<string>> = {};
    for (const diagnostic of diagnostics) {
        let owners = boxes.filter(box => box.start <= diagnostic.start &&
            (diagnostic.start < box.end || box.start === box.end && diagnostic.start === box.start));
        if (!owners.length) owners = boxes.filter(box => box.end === diagnostic.start);
        const covering = owners.filter(box => diagnostic.end <= box.end);
        if (covering.length) owners = covering;
        const size = Math.min(...owners.map(box => box.end - box.start));
        for (const owner of owners.filter(box => box.end - box.start === size))
            (messages[owner.id] ??= new Set()).add(diagnostic.message);
    }
    return Object.fromEntries(Object.entries(messages).map(([id, messages]) => [id, [...messages].join("\n\n")]));
}
