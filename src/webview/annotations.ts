import { annotationArguments, annotationArgumentSpans, annotationChoiceText, type AnnotationChoice, type AnnotationSite } from "../graphAnnotations";
import { literalOf, quoteString, textLiteralRows } from "./literals";
import { labelColumns, ENGLISH_VOCABULARY, type Vocabulary } from "./labels";

export function annotationPresentation(site: AnnotationSite, choice?: AnnotationChoice, vocabulary: Vocabulary = ENGLISH_VOCABULARY) {
    const parsed = annotationArguments(site.text);
    const text = parsed.arguments === undefined && choice ? annotationChoiceText(choice, site.text) : site.text;
    const parameters = annotationArgumentSpans(text).map(span => {
        const node = { kind: /^["']/.test(span.text) ? "string" : "float", start: 0, end: span.text.length, line: 1, column: 1 };
        const literal = literalOf(node, span.text);
        const kind: "number" | "string" | "name" = literal?.kind ?? "name", value = literal?.value ?? span.text;
        const typeLabel = literal ? vocabulary[literal.kind] : "";
        const columns = Math.max(...value.replace(/\t/g, "    ").split(/\r\n?|\n/).map(labelColumns));
        const width = literal ? Math.max(56, Math.ceil(Math.max(labelColumns(typeLabel), Math.min(48, columns) + (kind === "string" ? 2 : 0)) * 7.2) + 20)
            : Math.max(32, Math.ceil(Math.min(48, columns) * 7.2) + 8);
        const height = literal ? 44 + (kind === "string" ? textLiteralRows(value, 48) - 1 : 0) * 16 : 22;
        return { ...span, kind, value, typeLabel, width, height };
    });
    const nameWidth = Math.ceil(labelColumns(parsed.name) * 7.2) + 4;
    return { name: parsed.name, text, parameters, nameWidth,
        width: nameWidth + parameters.reduce((sum, parameter) => sum + parameter.width + 6, 0) + 18,
        height: Math.max(22, ...parameters.map(parameter => parameter.height + 6)) };
}
export type AnnotationParameter = ReturnType<typeof annotationPresentation>["parameters"][number];

export function annotationParameterText(text: string, parameter: AnnotationParameter, value: string): string {
    const source = parameter.kind === "string" ? quoteString(value) : value;
    return text.slice(0, parameter.start) + source + text.slice(parameter.end);
}
