import * as l10n from "@vscode/l10n";
import type { Vocabulary } from "./labels";
import { HATS } from "./vocabulary";

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
        hats: Object.fromEntries(Object.entries(HATS).map(([word, entry]) => [word, translate(entry.text)])),
        outer: l10n.t("Outer {0}: {1}"),
        levels: l10n.t("{0} ({1} levels)"),
    };
}
