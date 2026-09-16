import * as l10n from "@vscode/l10n";
import type { Vocabulary } from "./labels";
import { HATS } from "./vocabulary";

/** Called with the extension host's selected bundle, before laying out any graph. */
export function configureLocalization(bundle?: Record<string, string>): void {
    l10n.config({ contents: bundle ?? {} });
}

export function graphVocabulary(): Vocabulary {
    // Data-driven messages are extracted by scripts/extract-graph-vocabulary.cjs.
    const translate = l10n.t;
    return {
        constant: l10n.t("Define constant"),
        variable: l10n.t("Define variable"),
        string: l10n.t("Text"),
        number: l10n.t("Number"),
        tableDefinition: l10n.t("Table type definition"),
        hats: Object.fromEntries(Object.entries(HATS).map(([word, entry]) => [word, translate(entry.text)])),
        outer: l10n.t("Outer {0}: {1}"),
        levels: l10n.t("{0} ({1} levels)"),
    };
}
