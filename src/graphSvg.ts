import * as vscode from "vscode";

/** Save a graph snapshot independently of its source document. */
export async function saveGraphSvg(source: vscode.Uri, svg: string, active: () => boolean): Promise<vscode.Uri | undefined> {
    if (!active()) return;
    const destination = await vscode.window.showSaveDialog({
        title: vscode.l10n.t("Export graph as editable SVG"),
        saveLabel: vscode.l10n.t("Save SVG"),
        filters: { SVG: ["svg"] },
        defaultUri: source.with({ path: source.path.replace(/\.[^/.]+$/, "") + ".svg", query: "", fragment: "" }),
    });
    if (!destination || !active()) return;
    if (destination.toString() === source.toString() || !destination.path.toLowerCase().endsWith(".svg")) {
        throw new Error(vscode.l10n.t("Choose an .svg file for the exported graph."));
    }
    await vscode.workspace.fs.writeFile(destination, Buffer.from(svg, "utf8"));
    return destination;
}
