# L^ Language Support

**English** | [日本語](README.ja.md)

Language support for [L^ (lhat)](https://github.com/SAM-tak/lhat) in Visual
Studio Code. Open a `.lh` or `.lton` file to receive diagnostics and language
features from `lhatls`, L^'s language server.

![Symbol Highlight](images/screenshot01.png)

![Visual Scripting(WIP)](images/screenshot02.png)

## Install

Install **L^ Language Support** from the Visual Studio Marketplace, then open
an L^ workspace. Marketplace installs the platform-specific extension package
for your machine; it already contains the matching `lhatls` binary. No separate
language-server installation or network download at editor startup is needed.

The extension supports VS Code 1.85 and newer.

If you install a generic VSIX or build the extension from source, provide a
server yourself with `lhat.serverPath`, or put `lhatls` on `PATH`.

```json
{
  "lhat.serverPath": "/absolute/path/to/lhatls"
}
```

Use `lhatls.exe` on Windows. An explicit setting always takes precedence over
the bundled server, so it is also the way to try a locally built server.

## Features

- Syntax and semantic highlighting for L^ and LTON (`.lton`) files
- Live type-checking diagnostics
- Completion, hover information, go to definition, find references, and rename
- Document symbols and a graph-specific outline
- **Copy Signature** for copying the full inferred type of the name at the cursor
- **Toggle Disabled Code** (`Ctrl+Shift+/`) for switching whole statements off
  as `#[~ … ]#` and back on; the graph view shows them greyed out
- A read-only graph view of an L^ source file
- Debugging through the L^ Debug Adapter Protocol implementation

Open the Command Palette and run **L^: Show Graph View** to switch a `.lh`
file to its graph view. Run **L^: Show Source** to switch back. Set
`lhat.graph.openBeside` to `true` when the graph should open in a split editor.

Calls and operators place argument expressions in columns by depth. Each column
starts at the same top and retains source order. Input groups sit at the right
of each call card, with bent definition lines connecting them to the values.

For illustrations, use **SVG…** in the graph toolbar, choose whether to include
the background and editing controls, and select **Save SVG**. The export covers
the entire current level, including offscreen nodes, with the current folds,
language, colors and graph-only literal edits. Text, node groups and connections
remain editable in Inkscape. Editing the SVG does not change the L^ source.

## Debug L^ programs

The language server is included with the extension; the runtime is deliberately
not. Running or debugging a program requires the standalone `lhat` executable
from the [L^ releases](https://github.com/SAM-tak/lhat/releases), either on
`PATH` or named by `lhat.runtimePath`.

```json
{
  "lhat.runtimePath": "C:\\path\\to\\lhat.exe"
}
```

With a `.lh` file active, press <kbd>F5</kbd> to run it under the debugger.
Breakpoints, stepping, variables, expression evaluation, conditional
breakpoints, and program output are available in VS Code's normal debug views.
For a repeatable configuration, use a `launch.json` entry such as:

```json
{
  "type": "lhat",
  "request": "launch",
  "name": "Run current L^ program",
  "program": "${file}",
  "cwd": "${workspaceFolder}",
  "args": [],
  "stopOnEntry": false,
  "relaxed": false
}
```

## Workspace configuration

By default, `lhatls` checks L^ files in the workspace. Add an
`lhat-lsp.json` file at the workspace root to exclude generated or vendored
trees, retain specific generated sources, or show relaxed-only diagnostics as
warnings:

```json
{
  "exclude": ["build/", "**/node_modules/"],
  "force_include_files": ["build/generated/api.lh"],
  "strict": false
}
```

If your embedding host registers its own L^ API, generate `lhat-host.json` at
the workspace root so the language server can type-check against that API:

```sh
lhat --dump-host-api lhat-host.json
```

The generated file describes registrations for analysis only; it does not run
host callbacks. Regenerate it whenever the host API changes.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `lhat.serverPath` | empty | Override the bundled language server with a path, or use `lhatls` from `PATH` when no bundled server exists. |
| `lhat.messagesPath` | empty | Directory of the server's message catalogs, for diagnostics in VS Code's display language. When empty, the `messages` folder beside the server is used if present. |
| `lhat.serverAutoRestart` | `true` | Restart an unexpectedly stopped server. Disable it temporarily while repeatedly rebuilding a local server on Windows. |
| `lhat.runtimePath` | empty | Path to the standalone `lhat` runtime used by Run and Debug. |
| `lhat.graph.openBeside` | `false` | Open the graph in an editor split instead of replacing the current editor. |

## Development

The extension itself is a TypeScript project. To run it in an Extension
Development Host:

```sh
npm ci
npm run compile
```

Open this repository in VS Code and press <kbd>F5</kbd>. Build `lhatls` from
the [L^ repository](https://github.com/SAM-tak/lhat) and set
`lhat.serverPath` to that executable. While rebuilding a server on Windows,
set `lhat.serverAutoRestart` to `false` to keep the extension from restarting
the old process before the linker can replace it.

The L^ samples target zero-based indices (lhat commit `5529b14` or later).
After rebuilding the runtime, check every repository `.lh` file and run the
indexing regression sample with:

```sh
npm run test:lhat -- /path/to/rebuilt/lhat
```

`LHAT_RUNTIME` can also select the executable; otherwise it uses `lhat` from
`PATH`. This includes local, untracked samples and excludes ignored build
products. The runtime checks cover dense sequences, inclusive ranges, string
positions, variadic arguments, enum numbers and regex capture groups.

`npm test` includes SVG saving tests. `npm run test:svg` additionally checks the
export in a real browser; set `LHAT_TEST_BROWSER` to a Chrome/Edge executable if
it is not installed in a standard location. This checks offscreen content,
editable text, arrows, transparency, folding, drill-down and graph-only edits.

To create a local generic VSIX:

```sh
npm run package
```

That generic package intentionally contains no native binary. The release
workflow produces the platform-specific packages that bundle `lhatls`.

## License

Apache-2.0. See [LICENSE](LICENSE).
