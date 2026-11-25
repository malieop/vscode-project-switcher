import * as vscode from 'vscode';
import { OpenCodeAttention } from './opencodeStatus';

export const WINDOW_SCHEME = 'project-switcher-window';

export function windowUri(windowId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: WINDOW_SCHEME, path: `/${windowId}` });
}

const DECORATIONS: Record<OpenCodeAttention, { badge: string; colorId: string; tooltip: string }> = {
  waiting: { badge: '!', colorId: 'charts.orange', tooltip: 'OpenCode is waiting for input in this window' },
  finished: { badge: '●', colorId: 'charts.green', tooltip: 'OpenCode finished work in this window' },
};

/**
 * Colored attention markers on Open Windows rows (P-03). Kept out of the tree
 * items themselves so the P-05 window icon stays untouched.
 */
export class WindowDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidProvideFileDecorations = this.change.event;
  private states = new Map<string, OpenCodeAttention>();

  update(states: Map<string, OpenCodeAttention>): void {
    const changed: vscode.Uri[] = [];
    for (const id of new Set([...this.states.keys(), ...states.keys()])) {
      if (this.states.get(id) !== states.get(id)) changed.push(windowUri(id));
    }
    this.states = new Map(states);
    if (changed.length) this.change.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== WINDOW_SCHEME) return undefined;
    const state = this.states.get(uri.path.slice(1));
    if (!state) return undefined;
    const decoration = DECORATIONS[state];
    return { badge: decoration.badge, color: new vscode.ThemeColor(decoration.colorId), tooltip: decoration.tooltip };
  }

  dispose(): void { this.change.dispose(); }
}
