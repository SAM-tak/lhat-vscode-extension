import { annotationArguments, annotationArgumentSpans, annotationArgumentLimits, annotationChoiceText, type AnnotationChoice, type AnnotationSite } from "../graphAnnotations";
import type { StatementTemplate } from "../graphStatements";
import { validSymbolName } from "../graphNames";
import { isNumberLiteral, literalOf, quoteString, stringEscapeInput, textLiteralRows } from "./literals";
import { labelColumns, ENGLISH_VOCABULARY, type Vocabulary } from "./labels";

export function annotationPresentation(site: AnnotationSite, choice?: AnnotationChoice, vocabulary: Vocabulary = ENGLISH_VOCABULARY) {
    const parsed = annotationArguments(site.text);
    const text = parsed.arguments === undefined && choice ? annotationChoiceText(choice, site.text) : site.text;
    const parameters = annotationArgumentSpans(text).map(span => {
        const node = { kind: /^["']/.test(span.text) ? "string" : "float", start: 0, end: span.text.length, line: 1, column: 1 };
        const literal = literalOf(node, span.text);
        const escapes = node.kind === "string" && !literal;
        const kind: "number" | "string" | "name" = escapes ? "string" : literal?.kind ?? "name";
        const value = escapes ? stringEscapeInput(span.text.slice(1, -1)) : literal?.value ?? span.text;
        const typeLabel = kind === "name" ? "" : vocabulary[kind];
        const columns = Math.max(...value.replace(/\t/g, "    ").split(/\r\n?|\n/).map(labelColumns));
        const width = kind !== "name" ? Math.max(56, Math.ceil(Math.max(labelColumns(typeLabel), Math.min(48, columns) + (kind === "string" ? 2 : 0)) * 7.2) + 20)
            : Math.max(32, Math.ceil(Math.min(48, columns) * 7.2) + 8);
        const height = kind !== "name" ? 44 + (kind === "string" ? textLiteralRows(value, 48) - 1 : 0) * 16 : 22;
        return { ...span, kind, value, typeLabel, width, height, escapes };
    });
    const canAddArguments = parameters.length < annotationArgumentLimits(choice).maximum;
    const nameWidth = Math.ceil(labelColumns(parsed.name) * 7.2) + 4;
    return { name: parsed.name, text, parameters, nameWidth, canAddArguments,
        width: nameWidth + parameters.reduce((sum, parameter) => sum + parameter.width + 6, 0) + 18 + (canAddArguments ? 22 : 0),
        height: Math.max(22, ...parameters.map(parameter => parameter.height + 6)) };
}
export type AnnotationParameter = ReturnType<typeof annotationPresentation>["parameters"][number];

export function annotationArgumentTemplates(parameter?: AnnotationParameter): StatementTemplate[] {
    const value = parameter?.value ?? "";
    const choices: StatementTemplate[] = [
        { id: "number", label: "Number", text: isNumberLiteral(value) && !value.startsWith("+") ? value : "0" },
        { id: "string", label: "Text", text: parameter?.kind === "string"
            ? parameter.text + (parameter.text.startsWith('"""') ? "\n" : "") : quoteString(value) },
        { id: "name", label: "Name argument", text: validSymbolName(value) ? value : "name" },
        { id: "true", label: "True", text: "true^" }, { id: "false", label: "False", text: "false^" },
        { id: "nil", label: "Nil", text: "nil^" },
    ];
    if (parameter?.kind === "string" && !parameter.escapes) {
        choices.push({ id: "quoted", label: "Use escaped string", text: quoteString(value) });
        const raw = quoteString(value, true);
        if (raw.startsWith("'")) choices.push({ id: "raw", label: "Use raw string", text: raw });
        if (!/[\r\n\0]/.test(value)) choices.push({ id: "line", label: "Use a rest-of-line string", text: '"""' + value + "\n" });
    }
    if (parameter) choices.push({ id: "escapes", label: "Edit string escapes", text: parameter.text,
        input: { kind: "stringEscapes", value: parameter.text.startsWith('"') && !parameter.text.startsWith('"""')
            ? stringEscapeInput(parameter.text.slice(1, -1)) : quoteString(value).slice(1, -1) } });
    return choices;
}

export function annotationParameterText(text: string, parameter: AnnotationParameter, value: string): string {
    const source = parameter.escapes ? '"' + value + '"'
        : parameter.text.startsWith('"""') && !/[\r\n\0]/.test(value) ? '"""' + value
        : parameter.kind === "string" ? quoteString(value, parameter.text.startsWith("'")) : value;
    return text.slice(0, parameter.start) + source + text.slice(parameter.end);
}
