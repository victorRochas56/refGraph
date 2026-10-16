import * as vscode from 'vscode';
import * as path from 'path';
import { runRefGraph, RefGraphData, BinaryNotFoundError } from './runner';

export type ViewKind = 'force' | 'chord';

interface OpenMessage {
    type: 'open';
    file: string;
    line?: number;
}

interface ScanMessage {
    type: 'scan';
    directory: string;
    filesPattern: string;
    identifier: string;
    separator: string;
}

interface ShowPlanMessage {
    type: 'showPlan';
    text: string;
}

type WebviewMessage = { type: 'ready' } | { type: 'browse' } | ScanMessage | OpenMessage | ShowPlanMessage;

export class RefGraphPanel {
    public static current: RefGraphPanel | undefined;

    private data: RefGraphData | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    static async show(context: vscode.ExtensionContext, view: ViewKind): Promise<void> {
        if (RefGraphPanel.current) {
            RefGraphPanel.current.panel.reveal();
            RefGraphPanel.current.post({ type: 'setView', view });
            return;
        }

        const panel = vscode.window.createWebviewPanel('refgraph', 'RefGraph', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'd3', 'dist'),
            ],
        });

        RefGraphPanel.current = new RefGraphPanel(panel, context.extensionUri, view);
        await RefGraphPanel.current.refresh();
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private initialView: ViewKind,
    ) {
        panel.webview.html = this.html(panel.webview, extensionUri);

        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg), null, this.disposables);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        vscode.workspace.onDidChangeConfiguration(
            (e) => {
                if (e.affectsConfiguration('refgraph')) {
                    this.postConfig();
                }
            },
            null,
            this.disposables,
        );
    }

    async refresh(): Promise<void> {
        const folder = await pickFolder();
        if (!folder) {
            return;
        }

        this.postConfig();
        this.post({ type: 'loading' });
        try {
            this.data = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'RefGraph: scanning…' },
                () => runRefGraph(folder, this.extensionUri.fsPath),
            );
            this.post({ type: 'data', data: this.data });
        } catch (e) {
            const message = (e as Error).message;
            this.post({ type: 'error', message });
            if (e instanceof BinaryNotFoundError) {
                const choice = await vscode.window.showErrorMessage(
                    `RefGraph: ${message}. Run "npm run build:scanner" in the extension folder, or point refgraph.binaryPath at a build of main.cpp.`,
                    'Open Settings',
                );
                if (choice === 'Open Settings') {
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'refgraph.binaryPath');
                }
            } else {
                vscode.window.showErrorMessage(`RefGraph: ${message}`);
            }
        }
    }

    private async onMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.post({ type: 'setView', view: this.initialView });
                this.postConfig();
                if (this.data) {
                    this.post({ type: 'data', data: this.data });
                }
                break;
            case 'scan':
                await this.updateConfig(msg);
                await this.refresh();
                break;
            case 'browse':
                await this.browseDirectory();
                break;
            case 'showPlan': {
                // fallback when the webview cannot reach the clipboard
                const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: msg.text });
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                break;
            }
            case 'open':
                await this.open(msg.file, msg.line);
                break;
        }
    }

    private async open(file: string, line?: number): Promise<void> {
        if (!this.data) {
            return;
        }
        const uri = vscode.Uri.joinPath(vscode.Uri.file(this.data.root), file);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
            if (line && line > 0) {
                const pos = new vscode.Position(line - 1, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`RefGraph: could not open ${file}: ${(e as Error).message}`);
        }
    }

    // The toolbar edits the workspace settings so the values persist per project
    // and stay in sync with settings.json.
    private async updateConfig(msg: ScanMessage): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('refgraph');
        const target = vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        for (const key of ['directory', 'filesPattern', 'identifier', 'separator'] as const) {
            if (cfg.get<string>(key) !== msg[key]) {
                await cfg.update(key, msg[key], target);
            }
        }
    }

    // Folder picker for the directory field. The result is made relative to the
    // workspace folder when it lives inside it, so settings stay portable.
    private async browseDirectory(): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const cfg = vscode.workspace.getConfiguration('refgraph');
        const current = cfg.get<string>('directory', '.');
        const defaultUri = folder ? vscode.Uri.joinPath(folder.uri, current) : undefined;

        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri,
            openLabel: 'Scan this folder',
        });
        if (!picked || picked.length === 0) {
            return;
        }

        let directory = picked[0].fsPath;
        if (folder) {
            const rel = path.relative(folder.uri.fsPath, directory);
            if (rel === '') {
                directory = '.';
            } else if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                directory = rel.split(path.sep).join('/');
            }
        }
        this.post({ type: 'directoryPicked', directory });
    }

    private postConfig(): void {
        const cfg = vscode.workspace.getConfiguration('refgraph');
        this.post({
            type: 'config',
            directory: cfg.get<string>('directory', '.'),
            filesPattern: cfg.get<string>('filesPattern', ''),
            identifier: cfg.get<string>('identifier', 'struct'),
            separator: cfg.get<string>('separator', ' '),
        });
    }

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }

    private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const nonce = makeNonce();
        const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'd3', 'dist', 'd3.min.js'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>RefGraph</title>
</head>
<body>
    <div id="scanbar" class="bar">
        <label class="field" title="Directory to scan, relative to the workspace folder">Directory <input id="directory" type="text" spellcheck="false" aria-label="Directory to scan"><button id="btn-browse" type="button" title="Choose a folder…" aria-label="Choose a folder">…</button></label>
        <label class="field" title="Regex a file path (relative to the directory) must match to be scanned. JavaScript syntax, case-insensitive, unanchored — like the VS Code search box. Empty scans everything.">Files <input id="files" type="text" spellcheck="false" placeholder="\\.(cpp|hpp)$" aria-label="File path regex"></label>
        <label class="field" title="Declaration keyword the scanner looks for, e.g. struct or class">Keyword <input id="identifier" type="text" spellcheck="false" aria-label="Declaration keyword"></label>
        <label class="field" title="Text between the keyword and the symbol name, usually a single space">Separator <input id="separator" type="text" spellcheck="false" aria-label="Separator between keyword and symbol name"></label>
        <button id="btn-scan" type="button" title="Run the scanner with these settings (Enter)">Scan</button>
        <span class="spacer"></span>
        <span id="stats"></span>
    </div>
    <div id="toolbar" class="bar">
        <div class="seg" role="group" aria-label="View">
            <button id="btn-force" type="button">Force graph</button>
            <button id="btn-chord" type="button">File coupling</button>
            <button id="btn-split" type="button">Split header</button>
        </div>
        <input id="filter" type="text" placeholder="Filter symbols…" aria-label="Filter symbols" spellcheck="false">
        <label id="topFilesWrap" class="field" title="Keep only the N most coupled files">Top files <input id="topFiles" type="number" min="2" max="500" step="1" value="40"></label>
        <label id="minSharedWrap" class="field" title="Hide file pairs that share fewer than N symbols; the remaining ribbons get the freed space">Min shared <input id="minShared" type="number" min="1" max="999" step="1" value="1"></label>
        <label id="splitFileWrap" class="field" title="File whose declarations should be grouped into new headers">Header <select id="splitFile" aria-label="Header to split"></select></label>
        <label id="thresholdWrap" class="field" title="Two symbols are grouped when the files needing them overlap at least this much (Jaccard index). 1 = identical consumers only.">Similarity ≥ <input id="threshold" type="range" min="0.05" max="1" step="0.05" aria-label="Similarity threshold"><span id="thresholdValue"></span></label>
        <label id="mergeDepsWrap" class="field" title="Put each symbol in the same group as the symbols that use it, so no new header needs to include another"><input id="mergeDeps" type="checkbox"> keep dependencies together</label>
        <button id="btn-copyPlan" type="button" title="Copy the groups as a Markdown split plan">Copy plan</button>
    </div>
    <div id="legend"></div>
    <div id="canvas"></div>
    <div id="status"></div>
    <div id="tooltip" role="tooltip"></div>
    <script nonce="${nonce}" src="${d3Uri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private dispose(): void {
        RefGraphPanel.current = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('RefGraph: open a folder first.');
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to scan with refgraph' });
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
