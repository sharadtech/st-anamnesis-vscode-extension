import * as vscode from "vscode";
import { fetchCredentialSet, projectTagsOf } from "./api";
import { decryptCredentialSet, getEncryptionContext } from "./credentialsCrypto";

export class CredentialsViewPanel {
  public static current: CredentialsViewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _credentialId: string | undefined;

  private constructor(panel: vscode.WebviewPanel, credentialId?: string) {
    this._panel = panel;
    this._credentialId = credentialId;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
  }

  public static async createOrShow(
    extensionUri: vscode.Uri,
    credentialId: string
  ): Promise<CredentialsViewPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;

    if (CredentialsViewPanel.current && CredentialsViewPanel.current._panel) {
      CredentialsViewPanel.current._panel.reveal(column);
      CredentialsViewPanel.current._credentialId = credentialId;
      CredentialsViewPanel.current._panel.title = "View Credentials";
      CredentialsViewPanel.current._renderHtml();
      await CredentialsViewPanel.current._load();
      return CredentialsViewPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "anamnesisCredentialsView",
      "View Credentials",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    CredentialsViewPanel.current = new CredentialsViewPanel(panel, credentialId);
    CredentialsViewPanel.current._renderHtml();
    await CredentialsViewPanel.current._load();
    return CredentialsViewPanel.current;
  }

  public syncLock(credentialId: string, locked: boolean): void {
    if (this._credentialId !== credentialId) return;
    this._panel.webview.postMessage({ type: "lockState", locked });
  }

  public static closeIf(credentialId: string | undefined): void {
    if (!credentialId || !CredentialsViewPanel.current) return;
    if (CredentialsViewPanel.current._credentialId === credentialId) {
      CredentialsViewPanel.current._panel.dispose();
    }
  }

  private async _load(): Promise<void> {
    if (!this._credentialId) return;
    try {
      this._panel.webview.postMessage({ type: "loading" });
      const row = await fetchCredentialSet(this._credentialId);
      const ctx = await getEncryptionContext();
      const entries = decryptCredentialSet(row.cipher, ctx);
      this._panel.title = `View Credentials: ${row.name}`;
      this._panel.webview.postMessage({
        type: "view",
        id: row._id,
        name: row.name,
        description: row.description || "",
        projectTags: projectTagsOf(row),
        entries,
        locked: row.locked === true,
      });
    } catch (err) {
      this._panel.webview.postMessage({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "close") {
      this._panel.dispose();
      return;
    }
    if (msg.type === "copy") {
      const value = String(msg.value ?? "");
      const label = String(msg.label ?? "value").trim() || "value";
      try {
        await vscode.env.clipboard.writeText(value);
        this._panel.webview.postMessage({
          type: "copied",
          fieldId: String(msg.fieldId ?? ""),
        });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: could not copy ${label}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  private _renderHtml(): void {
    const nonce = getNonce();
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>View Credentials</title>
  <style>
    html, body { margin: 0; padding: 0; min-height: 100vh;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
    }
    #wrap { padding: 16px 18px 28px; max-width: 760px; }
    h1 { margin: 0 0 6px; font-size: 16px; }
    .hint { color: var(--vscode-descriptionForeground, #888); margin: 0 0 16px; font-size: 12px; }
    .banner { margin: 0 0 16px; padding: 8px 10px; font-size: 12px;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #3c3c3c); }
    .field { margin: 0 0 14px; }
    .field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 4px; }
    label { font-weight: 600; font-size: 12px; }
    .value { margin: 0; padding: 6px 8px; white-space: pre-wrap; word-break: break-word;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc); font-family: inherit; font-size: 12px; }
    .meta { color: var(--vscode-descriptionForeground, #888); font-weight: 400; margin-left: 6px; }
    button { padding: 4px 10px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff); font-size: 12px; }
    button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    button.primary { background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff); }
    .actions { display: flex; gap: 8px; margin-top: 16px; }
    .row-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .error { color: var(--vscode-errorForeground, #f44747); margin: 12px 0; }
    .muted { color: var(--vscode-descriptionForeground, #888); }
    #loader { display: none; padding: 24px 0; }
    #loader.show { display: block; }
    .spin { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid currentColor; border-top-color: transparent;
      animation: spin 0.7s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #view { display: none; }
    #view.show { display: block; }
  </style>
</head>
<body>
  <div id="wrap">
    <h1>View Credentials</h1>
    <p class="hint">Read-only. Unlock this set from the Credentials for AI list to edit it.</p>
    <div id="loader"><span class="spin"></span>Loading…</div>
    <div id="err" class="error" style="display:none;"></div>
    <div id="view">
      <div id="banner" class="banner">This credential set is locked. Delete is disabled until you unlock it.</div>
      <div id="fields"></div>
      <div class="actions">
        <button type="button" class="primary" id="closeBtn">Close</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const $ = (id) => document.getElementById(id);
      const fieldsEl = $("fields");
      const view = $("view");
      const loader = $("loader");
      const errEl = $("err");
      const banner = $("banner");

      function showError(msg) {
        loader.classList.remove("show");
        view.classList.remove("show");
        errEl.style.display = "block";
        errEl.textContent = msg;
      }

      function addField(fieldId, label, value, options) {
        const opts = options || {};
        const wrap = document.createElement("div");
        wrap.className = "field";
        const head = document.createElement("div");
        head.className = "field-head";
        const lab = document.createElement("label");
        lab.textContent = label;
        if (opts.meta) {
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = opts.meta;
          lab.appendChild(meta);
        }
        const actions = document.createElement("div");
        actions.className = "row-actions";
        const valueEl = document.createElement("p");
        valueEl.className = "value";
        const raw = value == null ? "" : String(value);
        let hidden = !!opts.secret;
        function paint() {
          if (!raw) {
            valueEl.textContent = "(empty)";
            valueEl.classList.add("muted");
          } else if (hidden) {
            valueEl.textContent = "••••••••";
            valueEl.classList.remove("muted");
          } else {
            valueEl.textContent = raw;
            valueEl.classList.remove("muted");
          }
        }
        paint();
        if (opts.secret) {
          const reveal = document.createElement("button");
          reveal.type = "button";
          reveal.textContent = "Show";
          reveal.addEventListener("click", function () {
            hidden = !hidden;
            reveal.textContent = hidden ? "Show" : "Hide";
            paint();
          });
          actions.appendChild(reveal);
        }
        const copy = document.createElement("button");
        copy.type = "button";
        copy.dataset.fieldId = fieldId;
        copy.textContent = "Copy";
        copy.addEventListener("click", function () {
          copy.disabled = true;
          vscode.postMessage({ type: "copy", fieldId: fieldId, label: label, value: raw });
        });
        actions.appendChild(copy);
        head.appendChild(lab);
        head.appendChild(actions);
        wrap.appendChild(head);
        wrap.appendChild(valueEl);
        fieldsEl.appendChild(wrap);
      }

      $("closeBtn").addEventListener("click", function () {
        vscode.postMessage({ type: "close" });
      });

      window.addEventListener("message", function (event) {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "loading") {
          loader.classList.add("show");
          view.classList.remove("show");
          errEl.style.display = "none";
        } else if (msg.type === "error") {
          showError(msg.error || "Failed to load credentials");
        } else if (msg.type === "view") {
          loader.classList.remove("show");
          errEl.style.display = "none";
          view.classList.add("show");
          fieldsEl.innerHTML = "";
          addField("name", "Name", msg.name || "");
          addField("description", "Description", msg.description || "");
          const tags = Array.isArray(msg.projectTags) ? msg.projectTags.filter(Boolean) : [];
          addField("projectTags", "Project tags", tags.join(", "));
          const entries = Array.isArray(msg.entries) ? msg.entries : [];
          if (!entries.length) {
            addField("entries", "Key / value pairs", "");
          }
          entries.forEach(function (entry, index) {
            const key = entry && entry.key ? String(entry.key) : "(no key)";
            const type = entry && entry.type === "password" ? "password" : "text";
            addField("entry-" + index, key, entry && entry.value != null ? entry.value : "", {
              meta: type,
              secret: type === "password"
            });
          });
          banner.textContent = msg.locked
            ? "This credential set is locked. Delete is disabled until you unlock it."
            : "This credential set is unlocked. Click it in the sidebar to edit it.";
        } else if (msg.type === "lockState") {
          banner.textContent = msg.locked
            ? "This credential set is locked. Delete is disabled until you unlock it."
            : "This credential set is unlocked. Click it in the sidebar to edit it.";
        } else if (msg.type === "copied") {
          const btn = fieldsEl.querySelector('button[data-field-id="' + msg.fieldId + '"]');
          if (!btn) return;
          btn.disabled = false;
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = prev || "Copy"; }, 1200);
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    CredentialsViewPanel.current = undefined;
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
