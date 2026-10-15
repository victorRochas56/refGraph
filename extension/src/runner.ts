import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RefEntry {
    file: string;
    count: number;
}

export interface SymbolEntry {
    name: string;
    decl: { file: string; line: number } | null;
    refs: RefEntry[];
}

// Mirrors the --json output of main.cpp. Paths are relative to root.
export interface RefGraphData {
    root: string;
    identifier: string;
    symbols: SymbolEntry[];
}

export class BinaryNotFoundError extends Error {
    constructor(public readonly tried: string[]) {
        super(`could not find the scanner (looked in ${tried.join(', ')} and PATH)`);
    }
}

const EXE = process.platform === 'win32' ? 'refGraph.exe' : 'refGraph';

// The scanner shipped inside the extension, one folder per platform.
export function bundledBinary(extensionPath: string): string {
    return path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, EXE);
}

// With no binaryPath configured: the bundled scanner, then the one built at the
// repository root (so F5 works during development). With one configured: that
// path, resolved against the workspace folder if relative. PATH is the last resort.
function resolveBinary(folder: vscode.WorkspaceFolder, extensionPath: string, configured: string): { binary: string; tried: string[] } {
    const candidates = configured
        ? [path.isAbsolute(configured) ? configured : path.join(folder.uri.fsPath, configured)]
        : [bundledBinary(extensionPath), path.resolve(extensionPath, '..', EXE)];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return { binary: candidate, tried: candidates };
        }
    }
    return { binary: configured || EXE, tried: candidates };
}

// Zip extraction does not always keep the executable bit.
function ensureExecutable(binary: string): void {
    if (process.platform === 'win32' || !path.isAbsolute(binary)) {
        return;
    }
    try {
        fs.accessSync(binary, fs.constants.X_OK);
    } catch {
        try {
            fs.chmodSync(binary, 0o755);
        } catch {
            // spawn will report the real problem
        }
    }
}

export function runRefGraph(folder: vscode.WorkspaceFolder, extensionPath: string): Promise<RefGraphData> {
    const cfg = vscode.workspace.getConfiguration('refgraph');
    const configured = cfg.get<string>('binaryPath', '').trim();
    const { binary, tried } = resolveBinary(folder, extensionPath, configured);
    const directory = cfg.get<string>('directory', '.');
    const identifier = cfg.get<string>('identifier', 'struct');
    const separator = cfg.get<string>('separator', ' ');
    const filesPattern = cfg.get<string>('filesPattern', '');

    const args = [directory, identifier, separator, '--json'];
    if (filesPattern) {
        args.push('--files', filesPattern);
    }

    ensureExecutable(binary);

    return new Promise((resolve, reject) => {
        cp.execFile(
            binary,
            args,
            { cwd: folder.uri.fsPath, maxBuffer: 256 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                        reject(new BinaryNotFoundError(tried));
                    } else {
                        reject(new Error(`${binary} failed: ${stderr.trim() || err.message}`));
                    }
                    return;
                }
                try {
                    resolve(JSON.parse(stdout) as RefGraphData);
                } catch (e) {
                    reject(new Error(`could not parse ${binary} output: ${(e as Error).message}`));
                }
            },
        );
    });
}
