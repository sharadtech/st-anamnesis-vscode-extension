import * as vscode from "vscode";
import { fetchAiContext, saveAiContext, updateAiContext } from "./api";

export class AiContextPanel {
  public static current: AiContextPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _recordId: string | undefined;
  private _onSaved: (() => void) | undefined;

  private constructor(panel: vscode.WebviewPanel, recordId?: string) {
    this._panel = panel;
    this._recordId = recordId;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
  }

  public static async createOrShow(
    extensionUri: vscode.Uri,
    recordId?: string,
    onSaved?: () => void
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
    if (AiContextPanel.current) {
      AiContextPanel.current._recordId = recordId;
      AiContextPanel.current._onSaved = onSaved;
      AiContextPanel.current._panel.reveal(column);
      await AiContextPanel.current._load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "anamnesisAiContext",
      recordId ? "Edit AI Context" : "New AI Context",
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    AiContextPanel.current = new AiContextPanel(panel, recordId);
    AiContextPanel.current._onSaved = onSaved;
    AiContextPanel.current._render(extensionUri);
    await AiContextPanel.current._load();
  }

  private async _load(): Promise<void> {
    this._panel.title = this._recordId ? "Edit AI Context" : "New AI Context";
    if (!this._recordId) {
      this._panel.webview.postMessage({ type: "record", projectName: "", context: "" });
      return;
    }
    try {
      const row = await fetchAiContext(this._recordId);
      this._panel.webview.postMessage({
        type: "record",
        projectName: row.projectName || "",
        context: row.context || "",
      });
    } catch (err) {
      this._panel.webview.postMessage({
        type: "status",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "cancel") {
      this._panel.dispose();
      return;
    }
    if (msg.type !== "save") return;
    const projectName = String(msg.projectName ?? "").trim();
    const context = String(msg.context ?? "");
    if (!projectName) {
      this._panel.webview.postMessage({
        type: "status",
        ok: false,
        detail: "Project name is required.",
      });
      return;
    }
    this._panel.webview.postMessage({ type: "status", running: true });
    try {
      if (this._recordId) {
        await updateAiContext(this._recordId, { projectName, context });
      } else {
        const saved = await saveAiContext({ projectName, context });
        this._recordId = String(saved._id || "");
      }
      this._onSaved?.();
      vscode.window.showInformationMessage(
        `Anamnesis: saved AI Context for "${projectName}".`
      );
      this._panel.dispose();
    } catch (err) {
      this._panel.webview.postMessage({
        type: "status",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _render(extensionUri: vscode.Uri): void {
    void extensionUri;
    const nonce = getNonce();
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Context</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { max-width: 760px; margin: 20px auto; padding: 0 20px 40px; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
    .sub { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin: 14px 0 6px; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
    textarea { min-height: 280px; resize: vertical; }
    .row { display: flex; gap: 8px; margin-top: 16px; }
    button { padding: 6px 14px; cursor: pointer; border: none; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 13px; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:disabled { opacity: 0.5; cursor: default; }
    .status { margin-top: 12px; min-height: 1.2em; }
    .status.err { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>AI Context</h1>
    <div class="sub">Save project context for the Anamnesis agent. The project name is the key used later to fetch this text.</div>
    <label for="projectName">Project name</label>
    <input id="projectName" type="text" placeholder="st-ck-client" />
    <label for="aiContext">AI Context</label>
    <textarea id="aiContext" placeholder="Architecture notes, conventions, and constraints the agent should follow for this project."></textarea>
    <div class="row">
      <button id="saveBtn">Save</button>
      <button id="cancelBtn" class="secondary">Cancel</button>
    </div>
    <div id="status" class="status"></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const projectName = document.getElementById("projectName");
      const aiContext = document.getElementById("aiContext");
      const saveBtn = document.getElementById("saveBtn");
      const cancelBtn = document.getElementById("cancelBtn");
      const status = document.getElementById("status");
      function setRunning(on) {
        saveBtn.disabled = on;
        cancelBtn.disabled = on;
      }
      saveBtn.addEventListener("click", function () {
        setRunning(true);
        status.className = "status";
        status.textContent = "Saving...";
        vscode.postMessage({
          type: "save",
          projectName: projectName.value,
          context: aiContext.value,
        });
      });
      cancelBtn.addEventListener("click", function () {
        vscode.postMessage({ type: "cancel" });
      });
      window.addEventListener("message", function (event) {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "record") {
          projectName.value = msg.projectName || "";
          aiContext.value = msg.context || "";
          setRunning(false);
          status.textContent = "";
        } else if (msg.type === "status") {
          if (msg.running) return;
          setRunning(false);
          status.className = "status err";
          status.textContent = msg.detail || "Could not save.";
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    AiContextPanel.current = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
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
