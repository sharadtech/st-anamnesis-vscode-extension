import * as vscode from "vscode";
import { testConnection } from "./api";
import {
  AI_TOOLS_DISABLED_KEY,
  detectIde,
  registerAiTools,
} from "./aiTools";

/**
 * A graphical editor for the Anamnesis configuration (API Base URL, Client Id,
 * Secret Key, default tag). Opened from the gear icon in the Projects view title.
 *
 * Saves are written to the VS Code `anamnesis.*` configuration scope
 * (Global by default; Workspace if the user picks "Save to Workspace").
 */
export class SettingsPanel {
  public static current: SettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _context: vscode.ExtensionContext;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._context = context;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
    this._renderHtml(extensionUri);
    this._pushCurrentValues();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext
  ): SettingsPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
    if (SettingsPanel.current) {
      SettingsPanel.current._panel.reveal(column);
      SettingsPanel.current._pushCurrentValues();
      return SettingsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "anamnesisSettings",
      "Anamnesis Settings",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [],
      }
    );
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, context);
    return SettingsPanel.current;
  }

  /** Send the current config values so the form is populated on open. */
  private _pushCurrentValues(): void {
    const cfg = vscode.workspace.getConfiguration("anamnesis");
    const ide = detectIde();
    this._panel.webview.postMessage({
      type: "values",
      serverUrl: cfg.get<string>("serverUrl") ?? "",
      clientId: cfg.get<string>("clientId") ?? "",
      secretKey: cfg.get<string>("secretKey") ?? "",
      defaultTag: cfg.get<string>("defaultTag") ?? "",
      targets: this._availableTargets(),
      ideLabel: ide.label,
      ideKind: ide.kind,
    });
  }

  private _availableTargets(): vscode.ConfigurationTarget[] {
    const targets: vscode.ConfigurationTarget[] = [];
    // Always allow Global; allow Workspace only inside a workspace.
    targets.push(vscode.ConfigurationTarget.Global);
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      targets.push(vscode.ConfigurationTarget.Workspace);
    }
    return targets;
  }

  private async _onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "test") {
      this._panel.webview.postMessage({ type: "testResult", running: true });
      const res = await testConnection(msg.serverUrl, msg.clientId, msg.secretKey);
      this._panel.webview.postMessage({
        type: "testResult",
        running: false,
        ok: res.ok,
        detail: res.detail,
        status: res.status,
      });
      return;
    }

    if (msg.type === "save") {
      const saved = await this._saveSettings(msg);
      this._pushCurrentValues();
      this._panel.webview.postMessage({
        type: "saved",
        ok: saved.ok,
        target: saved.target,
        detail: saved.detail,
      });
      return;
    }

    if (msg.type === "installAiTools") {
      const saved = await this._saveSettings(msg);
      this._pushCurrentValues();
      if (!saved.ok) {
        this._panel.webview.postMessage({
          type: "installResult",
          ok: false,
          detail: saved.detail || "Could not save settings before installing MCP and Skill.",
        });
        return;
      }
      const clientId = this._normalizeStr(msg.clientId);
      const secretKey = this._normalizeStr(msg.secretKey);
      if (!clientId || !secretKey) {
        this._panel.webview.postMessage({
          type: "installResult",
          ok: false,
          detail: "Client Id and Secret Key are required before installing MCP and Skill.",
        });
        return;
      }
      try {
        await this._context.globalState.update(AI_TOOLS_DISABLED_KEY, false);
        const res = await registerAiTools();
        this._panel.webview.postMessage({
          type: "installResult",
          ok: true,
          ideLabel: res.ideLabel,
          mcpPath: res.mcpPath,
          skillPath: res.skillPath,
        });
        const reload = await vscode.window.showInformationMessage(
          `Anamnesis: MCP and skill installed for ${res.ideLabel}. Reload the window so the IDE picks them up.`,
          "Reload Window"
        );
        if (reload === "Reload Window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } catch (err) {
        this._panel.webview.postMessage({
          type: "installResult",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async _saveSettings(msg: {
    serverUrl?: string;
    clientId?: string;
    secretKey?: string;
    defaultTag?: string;
    target?: string;
  }): Promise<{ ok: boolean; target?: string; detail?: string }> {
    try {
      const cfg = vscode.workspace.getConfiguration("anamnesis");
      const target =
        msg.target === "workspace" && vscode.workspace.workspaceFolders
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

      await cfg.update("serverUrl", this._normalizeUrl(String(msg.serverUrl ?? "")), target);
      await cfg.update("clientId", this._normalizeStr(String(msg.clientId ?? "")), target);
      await cfg.update("secretKey", this._normalizeStr(String(msg.secretKey ?? "")), target);
      await cfg.update(
        "defaultTag",
        this._normalizeStr(String(msg.defaultTag ?? "")) || "default",
        target
      );
      return {
        ok: true,
        target: target === vscode.ConfigurationTarget.Workspace ? "Workspace" : "Global",
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private _normalizeUrl(u: string): string {
    return (u || "").trim().replace(/\/+$/, "");
  }
  private _normalizeStr(s: string): string {
    return (s || "").trim();
  }

  private _renderHtml(extensionUri: vscode.Uri): void {
    const webview = this._panel.webview;
    const nonce = getNonce();

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
    style-src 'unsafe-inline';
    script-src 'nonce-${nonce}';
    connect-src http: https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Anamnesis Settings</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100vh; overflow: auto;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #333);
      background: var(--vscode-editor-background, #fff);
    }
    .wrap { max-width: 640px; margin: 20px auto; padding: 0 20px 60px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: var(--vscode-descriptionForeground, #666); font-size: 12px; margin-bottom: 18px; }
    .field { margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 4px; }
    .hint { color: var(--vscode-descriptionForeground, #888); font-size: 11px; margin-top: 3px; }
    input[type="text"], input[type="password"] {
      width: 100%; box-sizing: border-box; padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #333);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    input[type="password"] { letter-spacing: 0.5px; }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 18px; flex-wrap: wrap; }
    button {
      padding: 6px 14px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff); font-size: 13px;
    }
    button:hover { background: var(--vscode-button-hoverBackground, #0a5f0a); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, #5a5d5a);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    button:disabled { opacity: 0.5; cursor: default; }
    select {
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #333);
      font-size: 12px;
    }
    .status { margin-top: 14px; padding: 8px 10px; border-radius: 3px; font-size: 12px; display: none; }
    .status.ok { display: block; background: rgba(10,111,10,0.12); color: var(--vscode-testing-iconPassed, #0a6f0a); border: 1px solid rgba(10,111,10,0.3); }
    .status.err { display: block; background: rgba(211,47,47,0.12); color: var(--vscode-errorForeground, #d32f2f); border: 1px solid rgba(211,47,47,0.3); }
    .status.info { display: block; background: rgba(0,102,204,0.10); color: var(--vscode-textLink-foreground, #0066cc); border: 1px solid rgba(0,102,204,0.3); }
    .spin { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid currentColor; border-top-color: transparent;
      animation: a-spin 0.7s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes a-spin { to { transform: rotate(360deg); } }
    .target-row { margin-top: 0; }
    .target-row label { display: inline; font-weight: 400; }
    .ide-hint { color: var(--vscode-descriptionForeground, #888); font-size: 11px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Anamnesis Configuration</h1>
    <div class="sub">Connection credentials from Anamnesis Settings → View Credentials in the web app. Changes apply immediately and refresh the Projects view.</div>
    <div id="ideHint" class="ide-hint"></div>

    <div class="field">
      <label for="serverUrl">API Base URL</label>
      <input id="serverUrl" type="text" placeholder="https://apigateway.anamnesis.cloud" />
      <div class="hint">Defaults to production. Override for local development, e.g. <code>http://localhost:8080</code> (no trailing slash).</div>
    </div>

    <div class="field">
      <label for="clientId">Client Id</label>
      <input id="clientId" type="text" placeholder="68ad9831c947b9d4008cff3c" />
      <div class="hint">Your company id from Anamnesis Settings → View Credentials → Client Id.</div>
    </div>

    <div class="field">
      <label for="secretKey">Secret Key</label>
      <input id="secretKey" type="password" placeholder="paste secret key from View Credentials" />
      <div class="hint">A named secret key generated in Anamnesis Settings → View Credentials.</div>
    </div>

    <div class="field">
      <label for="defaultTag">Default Tag</label>
      <input id="defaultTag" type="text" placeholder="default" />
      <div class="hint">Graph tag loaded by default when none is selected (e.g. <code>default</code>).</div>
    </div>

    <div id="testStatus" class="status"></div>

    <div class="row">
      <button id="testBtn">Test Connection</button>
      <button id="saveBtn" class="secondary">Save</button>
      <button id="installBtn">Install MCP &amp; Skill</button>
      <div class="target-row">
        <label for="target">Save to:</label>
        <select id="target">
          <option value="global">Global (User settings)</option>
          <option value="workspace">Workspace</option>
        </select>
      </div>
    </div>

    <div id="saveStatus" class="status"></div>
    <div id="installStatus" class="status"></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const $ = (id) => document.getElementById(id);
      const serverUrl = $("serverUrl");
      const clientId = $("clientId");
      const secretKey = $("secretKey");
      const defaultTag = $("defaultTag");
      const testBtn = $("testBtn");
      const saveBtn = $("saveBtn");
      const installBtn = $("installBtn");
      const target = $("target");
      const testStatus = $("testStatus");
      const saveStatus = $("saveStatus");
      const installStatus = $("installStatus");
      const ideHint = $("ideHint");

      function formPayload(type) {
        return {
          type: type,
          serverUrl: serverUrl.value,
          clientId: clientId.value,
          secretKey: secretKey.value,
          defaultTag: defaultTag.value,
          target: target.value,
        };
      }

      function setRunning(on) {
        testBtn.disabled = on;
        saveBtn.disabled = on;
        installBtn.disabled = on;
      }

      function showStatus(el, kind, html) {
        el.className = "status " + kind;
        el.innerHTML = html;
      }

      testBtn.addEventListener("click", () => {
        setRunning(true);
        showStatus(testStatus, "info", '<span class="spin"></span>Testing connection...');
        saveStatus.className = "status";
        vscode.postMessage({
          type: "test",
          serverUrl: serverUrl.value,
          clientId: clientId.value,
          secretKey: secretKey.value,
        });
      });

      saveBtn.addEventListener("click", () => {
        setRunning(true);
        showStatus(saveStatus, "info", '<span class="spin"></span>Saving...');
        testStatus.className = "status";
        vscode.postMessage(formPayload("save"));
      });

      installBtn.addEventListener("click", () => {
        setRunning(true);
        showStatus(installStatus, "info", '<span class="spin"></span>Installing MCP and Skill for this IDE...');
        testStatus.className = "status";
        saveStatus.className = "status";
        vscode.postMessage(formPayload("installAiTools"));
      });

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "values") {
          serverUrl.value = msg.serverUrl || "";
          clientId.value = msg.clientId || "";
          secretKey.value = msg.secretKey || "";
          defaultTag.value = msg.defaultTag || "";
          // Hide workspace option if not available.
          const hasWs = (msg.targets || []).some((t) => t === 2 /* Workspace */);
          target.querySelector('option[value="workspace"]').disabled = !hasWs;
          if (!hasWs) target.value = "global";
          if (ideHint) {
            ideHint.textContent = msg.ideLabel
              ? "Detected IDE: " + msg.ideLabel + ". Install MCP & Skill writes files for this editor only."
              : "";
          }
        } else if (msg.type === "testResult") {
          if (msg.running) return;
          setRunning(false);
          if (msg.ok) {
            showStatus(testStatus, "ok", "Connected: " + escapeHtml(msg.detail));
          } else {
            showStatus(testStatus, "err", "Failed: " + escapeHtml(msg.detail));
          }
        } else if (msg.type === "saved") {
          setRunning(false);
          if (msg.ok) {
            showStatus(saveStatus, "ok", "Saved to " + escapeHtml(msg.target) + " settings. Projects view refreshed.");
          } else {
            showStatus(saveStatus, "err", "Could not save: " + escapeHtml(msg.detail || "unknown error"));
          }
        } else if (msg.type === "installResult") {
          setRunning(false);
          if (msg.ok) {
            showStatus(
              installStatus,
              "ok",
              "Installed MCP and Skill for " + escapeHtml(msg.ideLabel) +
                ".<br>MCP: " + escapeHtml(msg.mcpPath) +
                "<br>Skill: " + escapeHtml(msg.skillPath) +
                "<br>Reload the window if the agent does not see the tools yet."
            );
          } else {
            showStatus(installStatus, "err", "Install failed: " + escapeHtml(msg.detail || "unknown error"));
          }
        }
      });

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
    })();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    SettingsPanel.current = undefined;
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
