// L^ (lhat) -- the language-server binary a platform-specific package ships.
//
// A .vsix published with `vsce publish --target <platform>` carries lhatls
// for that platform in bin/, put there by the release workflow from what the
// lhat repository's own release built. The runtime is intentionally separate:
// it is useful as a standalone CLI and is only needed for debugging.
// An extension installed any other way -- from source, from a generic
// package -- ships none, and the caller falls back to PATH as before.
//
// Nothing here decides which binary to use. It answers what is shipped, and
// resolveServerCommand / resolveRuntimeCommand put that answer in its place:
// an explicit setting first, then this, then PATH.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

let root: string | undefined;

/** Told once, at activation: where this extension was installed. */
export function rememberExtensionRoot(context: vscode.ExtensionContext): void {
    root = context.extensionPath;
}

/**
 * The path to lhatls this package ships, or undefined when it ships none.
 *
 * Windows calls it lhatls.exe; other platforms call it lhatls.
 */
export function bundledServer(): string | undefined {
    if (root === undefined) {
        return undefined;
    }
    const exe = process.platform === "win32" ? "lhatls.exe" : "lhatls";
    const at = path.join(root, "bin", exe);
    if (!fs.existsSync(at)) {
        return undefined;
    }
    // A .vsix is a zip and a zip carries no execute bit, so everything but
    // Windows needs one put back before the file can be spawned. Doing it
    // here rather than at install time is what the extensions that ship a
    // binary all do -- there is no install hook to do it in.
    if (process.platform !== "win32") {
        try {
            const mode = fs.statSync(at).mode;
            if ((mode & 0o111) === 0) {
                fs.chmodSync(at, mode | 0o755);
            }
        } catch {
            // Unreadable or unwritable: let the caller fall through to PATH
            // rather than hand back something that cannot be run.
            return undefined;
        }
    }
    return at;
}
