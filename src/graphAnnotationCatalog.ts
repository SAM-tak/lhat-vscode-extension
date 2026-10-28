import * as vscode from "vscode";
import { parseAnnotationCatalog, type AnnotationChoice } from "./graphAnnotations";

/** Match the language server's nearest project configuration boundary. */
export async function readAnnotationCatalog(document: vscode.TextDocument): Promise<AnnotationChoice[] | undefined> {
    // A document without a filesystem location has no project catalog.
    if (!document.uri.path || !vscode.workspace.fs) return;
    let directory = vscode.Uri.joinPath(document.uri, "..");
    const boundary = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
    const read = async (uri: vscode.Uri) => {
        const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        return open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    };
    while (true) {
        try { return parseAnnotationCatalog(JSON.parse((await read(vscode.Uri.joinPath(directory, "lhat-host.json"))).replace(/^\uFEFF/, ""))); }
        catch (error) {
            if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") return [];
        }
        try { await read(vscode.Uri.joinPath(directory, "lhat-lsp.json")); return []; }
        catch (error) {
            if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") return [];
        }
        const parent = vscode.Uri.joinPath(directory, "..");
        if (directory.toString() === boundary?.toString() || parent.toString() === directory.toString()) return;
        directory = parent;
    }
}
