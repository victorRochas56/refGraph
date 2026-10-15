import * as vscode from 'vscode';
import { RefGraphPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('refgraph.showForceGraph', () => RefGraphPanel.show(context, 'force')),
        vscode.commands.registerCommand('refgraph.showChordDiagram', () => RefGraphPanel.show(context, 'chord')),
        vscode.commands.registerCommand('refgraph.refresh', () => RefGraphPanel.current?.refresh()),
    );
}

export function deactivate(): void {}
