import * as l10n from "@vscode/l10n";
import type { Vocabulary } from "./labels";
import { HATS } from "./vocabulary";
import { ASSIGNMENT_LABELS } from "../graphAssignments";

let vocabulary: Vocabulary | undefined;

/** Called with the extension host's selected bundle, before laying out any graph. */
export function configureLocalization(bundle?: Record<string, string>): void {
    l10n.config({ contents: bundle ?? {} });
    vocabulary = undefined;
}

export function graphVocabulary(): Vocabulary {
    if (vocabulary !== undefined) return vocabulary;
    // Data-driven messages are extracted by scripts/extract-graph-vocabulary.cjs.
    const translate = l10n.t;
    return vocabulary = {
        variableDefinition: l10n.t("Variable Definition"),
        mutableVariableDefinition: l10n.t("Mutable Variable Definition"),
        variableDeclaration: l10n.t("Variable Declaration"),
        mutableVariableDeclaration: l10n.t("Mutable Variable Declaration"),
        string: l10n.t("Text"),
        number: l10n.t("Number"),
        tableDefinition: l10n.t("Table type definition"),
        table: l10n.t("Table"),
        input: l10n.t("Input"), output: l10n.t("Output"),
        call: l10n.t("Call"),
        methodCall: l10n.t("Method Call"),
        condition: l10n.t("Condition"),
        conditionalBranch: l10n.t("Conditional Branch"),
        conditionalSelection: l10n.t("Conditional Selection"),
        pattern: l10n.t("Pattern"),
        patternBranch: l10n.t("Pattern Matching Branch"),
        patternSelection: l10n.t("Pattern Matching Selection"),
        assignments: Object.fromEntries(Object.entries(ASSIGNMENT_LABELS).map(([operator, text]) => [operator, translate(text)])),
        nilCheckedAssignment: l10n.t("{0} (nil-checked)"),
        noOutput: l10n.t("No output"), missingInput: l10n.t("Missing input"),
        hats: Object.fromEntries(Object.entries(HATS).map(([word, entry]) => [word, translate(entry.text)])),
        outer: l10n.t("Outer {0}: {1}"),
        levels: l10n.t("{0} ({1} levels)"),
    };
}
