import * as vscode from "vscode";
import { fetchGraph, fetchStats, type GraphData, type GraphStats } from "./api";

export class GraphPanel {
  public static current: GraphPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _tag: string;
  private _highlight?: string;

  private constructor(panel: vscode.WebviewPanel, tag: string) {
    this._panel = panel;
    this._tag = tag;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
  }

  public static async createOrShow(
    extensionUri: vscode.Uri,
    tag: string,
    highlight?: string
  ): Promise<GraphPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;

    if (GraphPanel.current && GraphPanel.current._panel) {
      GraphPanel.current._panel.reveal(column);
      GraphPanel.current._tag = tag;
      GraphPanel.current._panel.title = `Graph: ${tag}`;
      GraphPanel.current._highlight = highlight;
      await GraphPanel.current._load();
      return GraphPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "anamnesisGraph",
      `Graph: ${tag}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "webview")],
      }
    );

    GraphPanel.current = new GraphPanel(panel, tag);
    GraphPanel.current._highlight = highlight;
    GraphPanel.current._renderHtml(extensionUri);
    await GraphPanel.current._load();
    return GraphPanel.current;
  }

  private async _load(): Promise<void> {
    try {
      this._panel.title = `Graph: ${this._tag}`;
      this._panel.webview.postMessage({ type: "loading", tag: this._tag });
      const [graph, stats] = await Promise.all([
        fetchGraph(this._tag),
        fetchStats(this._tag).catch(() => null),
      ]);
      this._panel.title = `Graph: ${this._tag}`;
      this._panel.webview.postMessage({
        type: "graph",
        graph,
        stats,
        highlight: this._highlight,
      });
    } catch (err) {
      this._panel.webview.postMessage({
        type: "error",
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }

  public refresh(): Promise<void> {
    return this._load();
  }

  public get tag(): string {
    return this._tag;
  }

  public setTag(tag: string): Promise<void> {
    this._tag = tag;
    return this._load();
  }

  private async _onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "navigate" && msg.path) {
      // Open the source file in the editor; jump to loc line if present.
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let uri: vscode.Uri | undefined;
      if (ws) {
        uri = vscode.Uri.joinPath(vscode.Uri.file(ws), msg.path);
      } else {
        uri = vscode.Uri.file(msg.path);
      }
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const line = msg.line ? Math.max(0, parseInt(msg.line, 10) - 1) : 0;
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const range = editor.document.lineAt(Math.min(line, editor.document.lineCount - 1)).range;
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      } catch (e) {
        vscode.window.showWarningMessage(
          `Anamnesis: could not open ${msg.path}: ${e instanceof Error ? e.message : e}`
        );
      }
    } else if (msg.type === "search" && msg.query !== undefined) {
      // Search is done in-webview from the already-loaded graph; no host call needed.
    }
  }

  private _renderHtml(extensionUri: vscode.Uri): void {
    const webview = this._panel.webview;
    const cytoscapeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "webview", "cytoscape.min.js")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "webview", "graphView.js")
    );

    const nonce = getNonce();

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
    img-src ${webview.cspSource} https: data:;
    style-src 'unsafe-inline' ${webview.cspSource};
    script-src 'nonce-${nonce}' ${webview.cspSource};
    connect-src ${webview.cspSource} http: https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Anamnesis Knowledge Graph</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      color: var(--vscode-foreground, #333);
      background: var(--vscode-editor-background, #fff);
    }
    #toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      background: var(--vscode-sideBar-background, #f5f5f5);
      flex-wrap: wrap;
    }
    #search { flex: 1 1 220px; min-width: 120px; padding: 3px 6px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #333);
    }
    #toolbar button { padding: 3px 10px; cursor: pointer;
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 2px;
    }
    #toolbar button:hover {
      background: var(--vscode-button-hoverBackground, #0a5f0a);
    }
    .stats-bar { font-size: 11px; color: var(--vscode-descriptionForeground, #666);
      margin-left: auto; white-space: nowrap;
    }
    #main { display: flex; height: calc(100vh - 40px); }
    #graph-area { flex: 1 1 auto; min-width: 0; position: relative; overflow: hidden; }
    #table-view { position: absolute; inset: 0; overflow: auto; }
    #graph-view { position: absolute; inset: 0; display: none; }
    #cy-container { width: 100%; height: 100%; }
    #inspector { width: 320px; min-width: 240px; max-width: 420px;
      overflow-y: auto; border-left: 1px solid var(--vscode-panel-border, #ddd);
      padding: 8px 10px;
      background: var(--vscode-sideBar-background, #fafafa);
    }
    #inspector-empty { color: var(--vscode-descriptionForeground, #888);
      font-style: italic; padding: 8px 0;
    }
    .props { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
    .props th { text-align: left; font-weight: 600; padding: 2px 6px 2px 0;
      vertical-align: top; white-space: nowrap;
      color: var(--vscode-descriptionForeground, #555); width: 40%;
    }
    .props td { padding: 2px 0; word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; color: var(--vscode-foreground, #333);
    }
    h4 { margin: 12px 0 4px 0; font-size: 11px; text-transform: uppercase;
      color: var(--vscode-descriptionForeground, #666); letter-spacing: 0.5px;
    }
    .nblist { list-style: none; padding: 0; margin: 0; }
    .nblist li { padding: 2px 0; }
    .rel { font-size: 10px; color: var(--vscode-symbolIcon-functionForeground, #0a6f0a);
      background: var(--vscode-badge-background, #eee); padding: 0 3px; border-radius: 2px;
      margin-right: 4px;
    }
    a.nb { color: var(--vscode-textLink-foreground, #0066cc); cursor: pointer;
      text-decoration: underline;
    }
    a.nb:hover { color: var(--vscode-textLink-activeForeground, #004499); }
    .muted { color: var(--vscode-descriptionForeground, #888); }
    #jumpBtn { margin-top: 8px; width: 100%; padding: 4px;
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 2px; cursor: pointer;
    }
    .seg-group { display: inline-flex; gap: 0; border: 1px solid var(--vscode-input-border, #ccc);
      border-radius: 3px; overflow: hidden;
    }
    .seg-group button { padding: 3px 10px; cursor: pointer; border: none;
      background: var(--vscode-sideBar-background, #f0f0f0);
      color: var(--vscode-foreground, #333); font-size: 11px;
    }
    .seg-group button.active {
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff);
    }
    #layout-wrap { display: none; align-items: center; gap: 4px; }
    #layoutSelect { padding: 2px 4px; font-size: 11px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #333);
    }
    .table-info { padding: 4px 8px; font-size: 11px; color: var(--vscode-descriptionForeground, #666);
      background: var(--vscode-sideBar-background, #f5f5f5); border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      position: sticky; top: 0; z-index: 1;
    }
    .nodes-table { border-collapse: collapse; width: 100%; font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .nodes-table th { text-align: left; padding: 5px 8px; position: sticky; top: 28px;
      background: var(--vscode-sideBar-background, #eee); font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border, #ccc); white-space: nowrap;
      color: var(--vscode-descriptionForeground, #555);
    }
    .nodes-table td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, #eee);
      word-break: break-all; max-width: 360px; overflow: hidden; text-overflow: ellipsis;
    }
    .nodes-table .col-label { font-weight: 600; }
    .nodes-table .col-sf { color: var(--vscode-textLink-foreground, #0066cc); }
    .graph-row { cursor: pointer; }
    .graph-row:hover { background: var(--vscode-list-hoverBackground, #e8e8e8); }
    .graph-row.selected { background: var(--vscode-list-activeSelectionBackground, #d6e8ff); }
    .error { color: var(--vscode-errorForeground, #d32f2f); padding: 8px; }
    #loader-overlay { position: absolute; inset: 0; display: none; align-items: center;
      justify-content: center; flex-direction: column; gap: 10px; z-index: 20;
      background: var(--vscode-editor-background, rgba(255,255,255,0.92));
      backdrop-filter: blur(1px);
    }
    #loader-overlay.show { display: flex; }
    .spinner { width: 30px; height: 30px; border-radius: 50%;
      border: 3px solid var(--vscode-editorWidget-border, #cccccc);
      border-top-color: var(--vscode-button-background, #0a6f0a);
      animation: anamnesis-spin 0.8s linear infinite; will-change: transform;
    }
    @keyframes anamnesis-spin { to { transform: rotate(360deg); } }
    #loader-text { font-size: 11px; color: var(--vscode-descriptionForeground, #666);
      text-align: center; max-width: 260px;
    }
    .loader-pulse { animation: anamnesis-pulse 1.4s ease-in-out infinite; }
    @keyframes anamnesis-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
  </style>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search nodes..." />
    <div class="seg-group">
      <button id="viewTableBtn" class="active" title="Table view (fast)">Table</button>
      <button id="viewGraphBtn" title="Graph view (Cytoscape)">Graph</button>
    </div>
    <div id="layout-wrap">
      <label for="layoutSelect" style="font-size:11px;">Layout:</label>
      <select id="layoutSelect">
        <option value="cose">cose (force)</option>
        <option value="circle">circle</option>
        <option value="grid">grid</option>
        <option value="concentric">concentric</option>
        <option value="preset">preset</option>
      </select>
    </div>
    <button id="refreshBtn">Refresh</button>
    <button id="fitBtn" style="display:none;">Fit</button>
    <span id="stats" class="stats-bar">Loading...</span>
  </div>
  <div id="main">
    <div id="graph-area">
      <div id="table-view"><div id="table-container"><div class="muted">Loading...</div></div></div>
      <div id="graph-view"><div id="cy-container"></div></div>
      <div id="loader-overlay" role="status" aria-live="polite">
        <div class="spinner"></div>
        <div id="loader-text" class="loader-pulse">Rendering graph view...</div>
      </div>
    </div>
    <div id="inspector">
      <div id="inspector-empty">Click a node to inspect its properties.</div>
      <div id="inspector-content" style="display:none;"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${cytoscapeUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    GraphPanel.current = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
