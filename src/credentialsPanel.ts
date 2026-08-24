import * as vscode from "vscode";
import {
  createCredentialSet,
  deleteCredentialSet,
  fetchCredentialSet,
  fetchProjects,
  projectTagsOf,
  updateCredentialSet,
} from "./api";
import {
  CredentialEntry,
  decryptCredentialSet,
  encryptCredentialSet,
  getEncryptionContext,
} from "./credentialsCrypto";

export class CredentialsPanel {
  public static current: CredentialsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _credentialId: string | undefined;
  private _onSaved: (() => void) | undefined;

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
    credentialId?: string,
    onSaved?: () => void
  ): Promise<CredentialsPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;

    if (CredentialsPanel.current && CredentialsPanel.current._panel) {
      CredentialsPanel.current._panel.reveal(column);
      CredentialsPanel.current._credentialId = credentialId;
      CredentialsPanel.current._onSaved = onSaved;
      CredentialsPanel.current._panel.title = credentialId
        ? "Edit Credentials"
        : "Add Credentials";
      CredentialsPanel.current._renderHtml();
      await CredentialsPanel.current._load();
      return CredentialsPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "anamnesisCredentials",
      credentialId ? "Edit Credentials" : "Add Credentials",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    CredentialsPanel.current = new CredentialsPanel(panel, credentialId);
    CredentialsPanel.current._onSaved = onSaved;
    CredentialsPanel.current._renderHtml();
    await CredentialsPanel.current._load();
    return CredentialsPanel.current;
  }

  private async _load(): Promise<void> {
    let knownProjectTags: string[] = [];
    try {
      const { projects } = await fetchProjects();
      knownProjectTags = [...new Set(
        projects
          .map((p) => (p.graph_tag as string) || (p.project_name as string) || "")
          .filter(Boolean)
      )];
    } catch {
      knownProjectTags = [];
    }

    if (!this._credentialId) {
      this._panel.webview.postMessage({
        type: "form",
        mode: "create",
        name: "",
        description: "",
        projectTags: [],
        entries: [{ key: "", type: "text", value: "" }],
        knownProjectTags,
      });
      return;
    }

    try {
      this._panel.webview.postMessage({ type: "loading" });
      const row = await fetchCredentialSet(this._credentialId);
      const ctx = await getEncryptionContext();
      const entries = decryptCredentialSet(row.cipher, ctx);
      this._panel.title = `Credentials: ${row.name}`;
      this._panel.webview.postMessage({
        type: "form",
        mode: "edit",
        id: row._id,
        name: row.name,
        description: row.description || "",
        projectTags: projectTagsOf(row),
        entries: entries.length ? entries : [{ key: "", type: "text", value: "" }],
        knownProjectTags,
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

    if (msg.type === "cancel") {
      this._panel.dispose();
      return;
    }

    if (msg.type === "save") {
      const name = String(msg.name ?? "").trim();
      const description = String(msg.description ?? "");
      const projectTags = Array.isArray(msg.projectTags)
        ? [...new Set(
            (msg.projectTags as unknown[])
              .map((tag) => String(tag ?? "").trim())
              .filter(Boolean)
          )]
        : [];
      const entries = Array.isArray(msg.entries)
        ? (msg.entries as CredentialEntry[])
            .map((row) => ({
              key: String(row.key ?? "").trim(),
              type: row.type === "password" ? "password" as const : "text" as const,
              value: String(row.value ?? ""),
            }))
            .filter((row) => row.key)
        : [];

      if (!name) {
        vscode.window.showWarningMessage("Anamnesis: credential set name is required.");
        this._panel.webview.postMessage({ type: "saveError" });
        return;
      }
      if (entries.length === 0) {
        vscode.window.showWarningMessage("Anamnesis: add at least one key/value pair.");
        this._panel.webview.postMessage({ type: "saveError" });
        return;
      }

      try {
        this._panel.webview.postMessage({ type: "saving" });
        const ctx = await getEncryptionContext();
        const cipher = encryptCredentialSet(entries, ctx);
        const body = {
          name,
          description,
          projectTags,
          keyCount: entries.length,
          cipher,
        };
        if (this._credentialId) {
          await updateCredentialSet(this._credentialId, body);
          vscode.window.showInformationMessage(`Anamnesis: updated credentials "${name}".`);
        } else {
          const created = await createCredentialSet(body);
          this._credentialId = created._id;
          this._panel.title = `Credentials: ${name}`;
          vscode.window.showInformationMessage(`Anamnesis: saved credentials "${name}".`);
        }
        this._onSaved?.();
        this._panel.webview.postMessage({ type: "saved" });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: save failed: ${err instanceof Error ? err.message : err}`
        );
        this._panel.webview.postMessage({ type: "saveError" });
      }
      return;
    }

    if (msg.type === "delete") {
      if (!this._credentialId) return;
      const name = String(msg.name ?? "this credential set");
      const confirm = await vscode.window.showWarningMessage(
        `Delete credential set "${name}"?\nThis cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;
      try {
        await deleteCredentialSet(this._credentialId);
        vscode.window.showInformationMessage(`Anamnesis: deleted credentials "${name}".`);
        this._onSaved?.();
        this._panel.dispose();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: delete failed: ${err instanceof Error ? err.message : err}`
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
  <title>Credentials for AI</title>
  <style>
    html, body { margin: 0; padding: 0; min-height: 100vh;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
    }
    #wrap { padding: 16px 18px 28px; max-width: 760px; }
    h1 { margin: 0 0 6px; font-size: 16px; }
    .hint { color: var(--vscode-descriptionForeground, #888); margin-bottom: 16px; font-size: 12px; }
    label { display: block; font-weight: 600; margin: 0 0 4px; font-size: 12px; }
    input, select, textarea {
      width: 100%; box-sizing: border-box; margin-bottom: 12px; padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      font-family: inherit; font-size: 12px;
    }
    textarea { min-height: 56px; resize: vertical; }
    input[type="checkbox"] { width: auto; margin: 0 8px 0 0; }
    .check { display: flex; align-items: center; font-weight: 400; margin: 0 0 6px; }
    .tag-box { max-height: 180px; overflow: auto; margin-bottom: 8px; padding: 8px;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #3c3c3c); }
    .add-tag { display: flex; gap: 8px; margin-bottom: 12px; }
    .add-tag input { margin-bottom: 0; }
    .row { display: grid; grid-template-columns: 1fr 120px 1fr auto auto; gap: 8px; align-items: end; margin-bottom: 8px; }
    .row label { margin: 0 0 4px; }
    .row input, .row select { margin-bottom: 0; }
    .field-actions { display: flex; gap: 4px; padding-bottom: 1px; }
    button { padding: 6px 12px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff); font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff); }
    button.danger { background: var(--vscode-errorForeground, #c62828); color: #fff; }
    button:disabled { opacity: 0.55; cursor: default; }
    .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .error { color: var(--vscode-errorForeground, #f44747); margin: 12px 0; }
    .muted { color: var(--vscode-descriptionForeground, #888); }
    #loader { display: none; padding: 24px 0; }
    #loader.show { display: block; }
    .spin { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid currentColor; border-top-color: transparent;
      animation: spin 0.7s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #form { display: none; }
    #form.show { display: block; }
    #deleteBtn { display: none; }
    #deleteBtn.show { display: inline-block; }
  </style>
</head>
<body>
  <div id="wrap">
    <h1 id="heading">Add Credentials</h1>
    <p class="hint">Values are encrypted in the extension with your Secret Key before they are stored. The server only keeps ciphertext.</p>
    <div id="loader"><span class="spin"></span>Loading…</div>
    <div id="err" class="error" style="display:none;"></div>
    <form id="form">
      <label for="name">Name</label>
      <input id="name" type="text" placeholder="e.g. Production database" required />
      <label for="description">Description</label>
      <textarea id="description" placeholder="Optional notes for this credential set"></textarea>
      <label>Project tags (optional)</label>
      <p class="hint">Select every Anamnesis project this credential set applies to.</p>
      <div id="tagBox" class="tag-box"></div>
      <div class="add-tag">
        <input id="customTag" type="text" list="knownTags" placeholder="Add another project tag" />
        <button type="button" class="secondary" id="addTag">Add</button>
      </div>
      <datalist id="knownTags"></datalist>
      <label>Key / value pairs</label>
      <div id="rows"></div>
      <button type="button" class="secondary" id="addRow">Add field</button>
      <div class="actions">
        <button type="submit" id="saveBtn">Save</button>
        <button type="button" class="secondary" id="cancelBtn">Cancel</button>
        <button type="button" class="danger" id="deleteBtn">Delete</button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      let mode = "create";
      let setName = "";
      let selectedTags = [];
      let knownTags = [];
      const $ = (id) => document.getElementById(id);
      const rowsEl = $("rows");
      const form = $("form");
      const loader = $("loader");
      const errEl = $("err");
      const saveBtn = $("saveBtn");
      const deleteBtn = $("deleteBtn");

      function showError(msg) {
        loader.classList.remove("show");
        form.classList.remove("show");
        errEl.style.display = "block";
        errEl.textContent = msg;
      }

      function addRow(entry) {
        const wrap = document.createElement("div");
        wrap.className = "row";
        wrap.innerHTML =
          '<div><label>Key</label><input class="k" type="text" placeholder="DB_USERNAME" /></div>' +
          '<div><label>Type</label><select class="t"><option value="text">Text</option><option value="password">Password</option></select></div>' +
          '<div><label>Value</label><input class="v" type="text" placeholder="value" /></div>' +
          '<div class="field-actions"><button type="button" class="secondary reveal" title="Show or hide">Show</button></div>' +
          '<div class="field-actions"><button type="button" class="secondary remove" title="Remove">Remove</button></div>';
        const keyInput = wrap.querySelector(".k");
        const typeSel = wrap.querySelector(".t");
        const valInput = wrap.querySelector(".v");
        const revealBtn = wrap.querySelector(".reveal");
        keyInput.value = entry && entry.key ? entry.key : "";
        typeSel.value = entry && entry.type === "password" ? "password" : "text";
        valInput.value = entry && entry.value != null ? entry.value : "";
        valInput.type = typeSel.value === "password" ? "password" : "text";
        revealBtn.style.visibility = typeSel.value === "password" ? "visible" : "hidden";
        typeSel.addEventListener("change", function () {
          valInput.type = typeSel.value === "password" ? "password" : "text";
          revealBtn.textContent = "Show";
          revealBtn.style.visibility = typeSel.value === "password" ? "visible" : "hidden";
        });
        revealBtn.addEventListener("click", function () {
          if (valInput.type === "password") {
            valInput.type = "text";
            revealBtn.textContent = "Hide";
          } else if (typeSel.value === "password") {
            valInput.type = "password";
            revealBtn.textContent = "Show";
          }
        });
        wrap.querySelector(".remove").addEventListener("click", function () {
          wrap.remove();
        });
        rowsEl.appendChild(wrap);
      }

      function collectEntries() {
        return Array.prototype.slice.call(rowsEl.querySelectorAll(".row")).map(function (row) {
          return {
            key: row.querySelector(".k").value,
            type: row.querySelector(".t").value,
            value: row.querySelector(".v").value
          };
        });
      }

      function uniqueTags(list) {
        const seen = {};
        const out = [];
        (list || []).forEach(function (tag) {
          const value = String(tag || "").trim();
          if (!value || seen[value.toLowerCase()]) return;
          seen[value.toLowerCase()] = true;
          out.push(value);
        });
        return out;
      }

      function renderTagPicker() {
        const box = $("tagBox");
        const list = $("knownTags");
        box.innerHTML = "";
        list.innerHTML = "";
        const all = uniqueTags(knownTags.concat(selectedTags));
        if (!all.length) {
          const empty = document.createElement("p");
          empty.className = "muted";
          empty.textContent = "No projects yet. Type a tag below to add one.";
          empty.style.margin = "0";
          box.appendChild(empty);
        }
        all.forEach(function (tag) {
          const row = document.createElement("label");
          row.className = "check";
          const boxEl = document.createElement("input");
          boxEl.type = "checkbox";
          boxEl.value = tag;
          boxEl.checked = selectedTags.indexOf(tag) !== -1;
          boxEl.addEventListener("change", function () {
            if (boxEl.checked) {
              selectedTags = uniqueTags(selectedTags.concat([tag]));
            } else {
              selectedTags = selectedTags.filter(function (item) { return item !== tag; });
            }
            renderTagPicker();
          });
          const text = document.createElement("span");
          text.textContent = tag;
          row.appendChild(boxEl);
          row.appendChild(text);
          box.appendChild(row);
        });
        knownTags.forEach(function (tag) {
          const opt = document.createElement("option");
          opt.value = tag;
          list.appendChild(opt);
        });
      }

      function addCustomTag() {
        const input = $("customTag");
        const value = (input.value || "").trim();
        if (!value) return;
        selectedTags = uniqueTags(selectedTags.concat([value]));
        input.value = "";
        renderTagPicker();
      }

      $("addRow").addEventListener("click", function () {
        addRow({ key: "", type: "text", value: "" });
      });
      $("addTag").addEventListener("click", addCustomTag);
      $("customTag").addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          addCustomTag();
        }
      });
      $("cancelBtn").addEventListener("click", function () {
        vscode.postMessage({ type: "cancel" });
      });
      deleteBtn.addEventListener("click", function () {
        vscode.postMessage({ type: "delete", name: $("name").value || setName });
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        vscode.postMessage({
          type: "save",
          name: $("name").value,
          description: $("description").value,
          projectTags: selectedTags.slice(),
          entries: collectEntries()
        });
      });

      window.addEventListener("message", function (event) {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "loading") {
          loader.classList.add("show");
          form.classList.remove("show");
          errEl.style.display = "none";
        } else if (msg.type === "error") {
          showError(msg.error || "Failed to load credentials");
        } else if (msg.type === "form") {
          loader.classList.remove("show");
          errEl.style.display = "none";
          form.classList.add("show");
          mode = msg.mode || "create";
          setName = msg.name || "";
          $("heading").textContent = mode === "edit" ? "Edit Credentials" : "Add Credentials";
          $("name").value = msg.name || "";
          $("description").value = msg.description || "";
          knownTags = msg.knownProjectTags || [];
          selectedTags = uniqueTags(msg.projectTags || []);
          renderTagPicker();
          rowsEl.innerHTML = "";
          const entries = msg.entries && msg.entries.length ? msg.entries : [{ key: "", type: "text", value: "" }];
          entries.forEach(addRow);
          deleteBtn.classList.toggle("show", mode === "edit");
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
        } else if (msg.type === "saving") {
          saveBtn.disabled = true;
          saveBtn.textContent = "Saving…";
        } else if (msg.type === "saveError" || msg.type === "saved") {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    CredentialsPanel.current = undefined;
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
