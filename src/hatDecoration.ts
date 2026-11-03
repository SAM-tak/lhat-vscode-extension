// Dims the '^' that ends a hat word ([lex.hat]).
//
// A decoration rather than a token colour rule: an extension's default for
// editor.tokenColorCustomizations is replaced whole by any other extension's,
// so a rule there disappears as soon as another language contributes one. A
// decoration keeps the theme's colour and only lowers its opacity, which no
// other extension's setting reaches.

import * as vscode from "vscode";

// Every run of '^' right after a word character. Comments and strings are
// not told apart: a hat dimmed there costs nothing.
const HATS = /(?<=[\p{L}\p{N}_])\^+/gu;

export function registerHatDecoration(
    context: vscode.ExtensionContext,
    section: string,
    languages: readonly string[],
): void {
    const create = () =>
        vscode.window.createTextEditorDecorationType({
            opacity: String(
                vscode.workspace.getConfiguration(section).get<number>("hatOpacity", 0.5),
            ),
        });
    let type = create();

    const decorate = (editor: vscode.TextEditor) => {
        const document = editor.document;
        if (!languages.includes(document.languageId)) {
            return;
        }
        const ranges: vscode.Range[] = [];
        for (const match of document.getText().matchAll(HATS)) {
            const start = match.index ?? 0;
            ranges.push(new vscode.Range(
                document.positionAt(start),
                document.positionAt(start + match[0].length),
            ));
        }
        editor.setDecorations(type, ranges);
    };
    const decorateAll = () => vscode.window.visibleTextEditors.forEach(decorate);

    decorateAll();
    context.subscriptions.push(
        { dispose: () => type.dispose() },
        vscode.window.onDidChangeVisibleTextEditors(decorateAll),
        vscode.workspace.onDidChangeTextDocument((event) =>
            vscode.window.visibleTextEditors
                .filter((editor) => editor.document === event.document)
                .forEach(decorate)),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${section}.hatOpacity`)) {
                type.dispose();
                type = create();
                decorateAll();
            }
        }),
    );
}
