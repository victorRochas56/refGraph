# RefGraph

Visualizes the output of the `refGraph` scanner (`../main.cpp`) inside VS Code.

Two views, switchable from the panel toolbar:

- **Force graph** – symbols (circles) linked to the files that reference them (squares, coloured by
  top-level directory). Node size is the total reference count, edge width the per-file count, and a
  dashed edge marks the file that declares the symbol. Click a file to open it, a symbol to jump to its
  declaration.
- **File coupling** – a chord diagram where two files are joined when they reference the same symbol.
  Ribbon width is the number of shared symbols; arcs are ordered by directory. Hover a ribbon to see
  which symbols the pair shares, click an arc to open the file. **Top files** caps the ring at the N
  most coupled files and **Min shared** hides pairs sharing fewer than N symbols — both make the
  remaining ribbons thicker, since ribbons split each arc proportionally.

The top row configures the scanner and is saved to the workspace settings; press Enter or **Scan**
to re-run with it:

- **Directory** – folder to scan, relative to the workspace (**…** opens a folder picker).
- **Files** – regular expression a file's path (relative to the directory, `/` separators) must match
  to be scanned. JavaScript syntax, case-insensitive and unanchored, the same rules as the VS Code
  search box, so `\.(cpp|hpp)$` keeps C++ sources and `^src/(?!generated/).*\.ts$` keeps hand-written
  TypeScript. Empty scans everything. The field turns red on a syntax error.
- **Keyword** and **Separator** – what a declaration looks like (`struct` + a space by default).

The second row controls the view. The filter box restricts both views to symbols whose name contains
the text.

## Build

```sh
cd extension
npm install
npm run build:scanner   # compiles ../main.cpp into bin/<platform>-<arch>/
npm run compile
```

Then press F5 from the repository root (the launch config in `.vscode/launch.json` opens the repo as
the workspace of the extension host) and run **RefGraph: Show Force Graph** from the command palette.

## Package

```sh
npm run package         # -> refgraph-<version>.vsix
code --install-extension refgraph-0.0.1.vsix
```

The scanner is bundled inside the VSIX from `bin/`. It is only ~80 KB, so build it for each platform
you want to support before packaging and ship one universal VSIX:

```sh
npm run build:scanner                                              # host platform
TARGET=linux-arm64 CXX=aarch64-linux-gnu-g++ npm run build:scanner  # cross-compile
TARGET=win32-x64 CXX=x86_64-w64-mingw32-g++ npm run build:scanner
```

`TARGET` is `<process.platform>-<process.arch>` as reported by Node on the target machine:
`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `refgraph.binaryPath` | *(empty)* | Custom scanner executable. Empty uses the bundled one (falling back to `../refGraph` during development). Relative paths are tried against the workspace folder, then PATH. |
| `refgraph.directory` | `.` | Directory to scan, relative to the workspace folder. |
| `refgraph.filesPattern` | *(empty)* | Regex a file path must match to be scanned (JavaScript syntax, case-insensitive, unanchored). |
| `refgraph.identifier` | `struct` | Declaration keyword. |
| `refgraph.separator` | ` ` | Separator between keyword and symbol name. |

The scanner is run as `<binaryPath> <directory> <identifier> <separator> --json [--files <regex>]`
with the workspace folder as working directory.
