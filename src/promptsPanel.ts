import * as vscode from "vscode";
import {
  fetchPrompts,
  createPrompt,
  updatePrompt,
  deletePromptEntry,
} from "./api";

export class PromptsPanel {
  public static current: PromptsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _projectName: string;

  private constructor(panel: vscode.WebviewPanel, projectName: string) {
    this._panel = panel;
    this._projectName = projectName;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
  }

  public static async createOrShow(
    extensionUri: vscode.Uri,
    projectName: string
  ): Promise<PromptsPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;

    if (PromptsPanel.current && PromptsPanel.current._panel) {
      PromptsPanel.current._panel.reveal(column);
      PromptsPanel.current._projectName = projectName;
      PromptsPanel.current._panel.title = `Prompts: ${projectName}`;
      await PromptsPanel.current._load();
      return PromptsPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "anamnesisPrompts",
      `Prompts: ${projectName}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    PromptsPanel.current = new PromptsPanel(panel, projectName);
    PromptsPanel.current._renderHtml();
    await PromptsPanel.current._load();
    return PromptsPanel.current;
  }

  private async _load(): Promise<void> {
    try {
      this._panel.title = `Prompts: ${this._projectName}`;
      this._panel.webview.postMessage({ type: "loading", projectName: this._projectName });
      const rows = await fetchPrompts(this._projectName);
      this._panel.webview.postMessage({
        type: "prompts",
        projectName: this._projectName,
        rows,
      });
    } catch (err) {
      this._panel.webview.postMessage({
        type: "error",
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    if (!msg || typeof msg !== "object") {
      return;
    }

    if (msg.type === "refresh") {
      await this._load();
      return;
    }

    if (msg.type === "copy" && typeof msg.text === "string") {
      await vscode.env.clipboard.writeText(msg.text);
      vscode.window.showInformationMessage("Anamnesis: copied to clipboard.");
      return;
    }

    if (msg.type === "saveCreate") {
      const title = String(msg.title ?? "").trim();
      const prompt = String(msg.prompt ?? "");
      if (!title || !prompt.trim()) {
        vscode.window.showWarningMessage("Anamnesis: title and prompt are required.");
        return;
      }
      try {
        this._panel.webview.postMessage({ type: "saving", mode: "create" });
        await createPrompt(this._projectName, { title, prompt });
        vscode.window.showInformationMessage(
          `Anamnesis: prompt "${title}" created and queued for AI improvement.`
        );
        await this._load();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: create failed: ${err instanceof Error ? err.message : err}`
        );
        this._panel.webview.postMessage({ type: "saveError", mode: "create" });
      }
      return;
    }

    if (msg.type === "saveEdit") {
      const id = String(msg.id ?? "");
      const title = String(msg.title ?? "").trim();
      const prompt = String(msg.prompt ?? "");
      if (!id || !title || !prompt.trim()) {
        vscode.window.showWarningMessage("Anamnesis: title and prompt are required.");
        return;
      }
      try {
        this._panel.webview.postMessage({ type: "saving", id, mode: "edit" });
        await updatePrompt(this._projectName, id, {
          title,
          prompt,
          validateWithAi: true,
        });
        vscode.window.showInformationMessage(
          `Anamnesis: prompt "${title}" updated and queued for AI improvement.`
        );
        await this._load();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: update failed: ${err instanceof Error ? err.message : err}`
        );
        this._panel.webview.postMessage({ type: "saveError", id, mode: "edit" });
      }
      return;
    }

    if (msg.type === "delete") {
      const id = String(msg.id ?? "");
      const title = String(msg.title ?? "this prompt");
      if (!id) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete prompt "${title}" from project "${this._projectName}"?\nThis cannot be undone.`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") {
        return;
      }
      try {
        await deletePromptEntry(this._projectName, id);
        vscode.window.showInformationMessage(`Anamnesis: deleted prompt "${title}".`);
        await this._load();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: delete failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  private _renderHtml(): void {
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
  <title>Anamnesis Project Prompts</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      color: var(--vscode-foreground, #333);
      background: var(--vscode-editor-background, #fff);
    }
    #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      background: var(--vscode-sideBar-background, #f5f5f5);
    }
    #toolbar h1 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    #toolbar button { padding: 4px 12px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff); font-size: 12px;
    }
    #toolbar button:hover { background: var(--vscode-button-hoverBackground, #0a5f0a); }
    #toolbar button:disabled { opacity: 0.5; cursor: default; }
    #table-wrap { height: calc(100vh - 44px); overflow: auto; }
    .table-info { padding: 6px 10px; font-size: 11px;
      color: var(--vscode-descriptionForeground, #666);
      background: var(--vscode-sideBar-background, #f5f5f5);
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      position: sticky; top: 0; z-index: 2;
    }
    .prompts-table { border-collapse: collapse; width: 100%; font-size: 11px;
      table-layout: fixed;
    }
    .prompts-table th { text-align: left; padding: 6px 8px; position: sticky; top: 28px;
      background: var(--vscode-sideBar-background, #eee); font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border, #ccc);
      color: var(--vscode-descriptionForeground, #555);
      cursor: pointer; user-select: none; white-space: nowrap; z-index: 1;
    }
    .prompts-table th:hover { background: var(--vscode-list-hoverBackground, #e0e0e0); }
    .prompts-table th .sort { margin-left: 4px; opacity: 0.6; font-size: 10px; }
    .prompts-table td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #eee);
      vertical-align: top; word-break: break-word;
    }
    .prompts-table tr:hover { background: var(--vscode-list-hoverBackground, #f0f0f0); }
    .col-title { width: 12%; font-weight: 600; }
    .col-prompt { width: 22%; }
    .col-ai { width: 22%; }
    .col-precision { width: 7%; text-align: center; }
    .col-status { width: 8%; }
    .col-updated { width: 10%; white-space: nowrap; }
    .col-actions { width: 10%; white-space: nowrap; }
    .cell-preview { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      overflow: hidden; margin-bottom: 4px; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; color: var(--vscode-descriptionForeground, #666);
    }
    .cell-empty { font-style: italic; color: var(--vscode-descriptionForeground, #888); }
    .btn-sm { padding: 2px 6px; font-size: 10px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-secondaryBackground, #5a5d5a);
      color: var(--vscode-button-secondaryForeground, #fff); margin-right: 4px;
    }
    .btn-sm:hover { opacity: 0.9; }
    .btn-sm.danger { background: var(--vscode-errorForeground, #c62828); color: #fff; }
    .status-ready { color: var(--vscode-testing-iconPassed, #0a6f0a); }
    .status-processing { color: var(--vscode-textLink-foreground, #0066cc); }
    .status-failed { color: var(--vscode-errorForeground, #d32f2f); }
    .muted { color: var(--vscode-descriptionForeground, #888); padding: 16px; }
    .error { color: var(--vscode-errorForeground, #d32f2f); padding: 16px; }
    #loader { display: none; padding: 24px; text-align: center;
      color: var(--vscode-descriptionForeground, #666);
    }
    #loader.show { display: block; }
    .spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid currentColor; border-top-color: transparent;
      animation: spin 0.7s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #modal-overlay { display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.45); align-items: center; justify-content: center;
    }
    #modal-overlay.show { display: flex; }
    #modal { background: var(--vscode-editor-background, #fff);
      border: 1px solid var(--vscode-panel-border, #ccc);
      border-radius: 4px; padding: 16px; width: min(560px, 92vw);
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    }
    #modal h2 { margin: 0 0 12px; font-size: 14px; }
    #modal label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; }
    #modal input, #modal textarea { width: 100%; box-sizing: border-box; margin-bottom: 12px;
      padding: 6px 8px; border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #333);
      font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
    }
    #modal textarea { min-height: 120px; resize: vertical; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .modal-actions button { padding: 6px 14px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff); font-size: 12px;
    }
    .modal-actions button.secondary {
      background: var(--vscode-button-secondaryBackground, #5a5d5a);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <h1 id="projectTitle">Project Prompts</h1>
    <button id="addPromptBtn">Add Prompt</button>
    <button id="refreshBtn">Refresh</button>
  </div>
  <div id="loader"><span class="spin"></span>Loading prompts...</div>
  <div id="table-wrap" style="display:none;">
    <div id="table-info" class="table-info"></div>
    <table class="prompts-table">
      <thead>
        <tr>
          <th data-col="title" class="col-title">Title<span class="sort"></span></th>
          <th data-col="prompt" class="col-prompt">Original Prompt<span class="sort"></span></th>
          <th data-col="aiCreatedPrompt" class="col-ai">AI-Generated Prompt<span class="sort"></span></th>
          <th data-col="precision" class="col-precision">Precision<span class="sort"></span></th>
          <th data-col="status" class="col-status">Status<span class="sort"></span></th>
          <th data-col="updatedAt" class="col-updated">Updated<span class="sort"></span></th>
          <th class="col-actions">Actions</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div id="empty" class="muted" style="display:none;">No prompts found for this project.</div>
  <div id="err" class="error" style="display:none;"></div>

  <div id="modal-overlay">
    <div id="modal">
      <h2 id="modalHeading">Edit Prompt</h2>
      <label for="editTitle">Title</label>
      <input id="editTitle" type="text" />
      <label for="editPrompt">Original Prompt</label>
      <textarea id="editPrompt"></textarea>
      <div class="modal-actions">
        <button type="button" class="secondary" id="cancelEdit">Cancel</button>
        <button type="button" id="savePromptBtn">Save</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      let rows = [];
      let projectName = "";
      let sortCol = "updatedAt";
      let sortDir = "desc";
      let editingId = null;
      let modalMode = "edit";

      const $ = (id) => document.getElementById(id);
      const loader = $("loader");
      const tableWrap = $("table-wrap");
      const tbody = $("tbody");
      const tableInfo = $("table-info");
      const emptyEl = $("empty");
      const errEl = $("err");
      const projectTitle = $("projectTitle");
      const modalOverlay = $("modal-overlay");
      const modalHeading = $("modalHeading");
      const editTitle = $("editTitle");
      const editPrompt = $("editPrompt");
      const savePromptBtn = $("savePromptBtn");

      function openModal(mode, row) {
        modalMode = mode;
        editingId = mode === "edit" && row ? String(row._id ?? "") : null;
        editTitle.value = row ? (row.title || "") : "";
        editPrompt.value = row ? (row.prompt || "") : "";
        modalHeading.textContent = mode === "create" ? "Add Prompt" : "Edit Prompt";
        savePromptBtn.textContent = mode === "create"
          ? "Create Prompt"
          : "Save & Re-validate with AI";
        savePromptBtn.disabled = false;
        modalOverlay.classList.add("show");
        editTitle.focus();
      }

      function closeModal() {
        modalOverlay.classList.remove("show");
        editingId = null;
        modalMode = "edit";
      }

      function resetSaveButton() {
        savePromptBtn.disabled = false;
        savePromptBtn.textContent = modalMode === "create"
          ? "Create Prompt"
          : "Save & Re-validate with AI";
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      function truncate(s, max) {
        const t = String(s || "").trim();
        if (t.length <= max) return t;
        return t.slice(0, max) + "…";
      }

      function formatDate(iso) {
        if (!iso) return "—";
        try {
          const d = new Date(iso);
          return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
        } catch { return String(iso); }
      }

      function statusClass(status) {
        if (status === "ready") return "status-ready";
        if (status === "failed") return "status-failed";
        return "status-processing";
      }

      function compare(a, b, col) {
        let va = a[col];
        let vb = b[col];
        if (col === "precision") {
          va = Number(va) || 0;
          vb = Number(vb) || 0;
          return va - vb;
        }
        if (col === "updatedAt" || col === "createdAt") {
          va = va ? new Date(va).getTime() : 0;
          vb = vb ? new Date(vb).getTime() : 0;
          return va - vb;
        }
        va = String(va ?? "").toLowerCase();
        vb = String(vb ?? "").toLowerCase();
        return va.localeCompare(vb);
      }

      function sortedRows() {
        const copy = rows.slice();
        copy.sort((a, b) => {
          const c = compare(a, b, sortCol);
          return sortDir === "asc" ? c : -c;
        });
        return copy;
      }

      function updateSortIndicators() {
        document.querySelectorAll(".prompts-table th[data-col]").forEach((th) => {
          const col = th.getAttribute("data-col");
          const span = th.querySelector(".sort");
          if (col === sortCol) {
            span.textContent = sortDir === "asc" ? "▲" : "▼";
          } else {
            span.textContent = "";
          }
        });
      }

      function renderPromptCell(rowId, field, text) {
        const t = String(text || "").trim();
        if (!t) {
          return '<span class="cell-empty">—</span>';
        }
        const escaped = escapeHtml(truncate(t, 200));
        return '<div class="cell-preview" title="' + escapeHtml(t) + '">' + escaped + '</div>' +
          '<button type="button" class="btn-sm copy-btn" data-row-id="' + escapeHtml(rowId) + '" data-field="' + field + '">Copy</button>';
      }

      function renderTable() {
        const sorted = sortedRows();
        tableInfo.textContent = sorted.length + " prompt(s) · click column headers to sort";
        tbody.innerHTML = sorted.map((row) => {
          const id = String(row._id ?? "");
          const title = escapeHtml(row.title || "");
          const status = String(row.status || "processing");
          const precision = row.precision != null ? Number(row.precision).toFixed(1) : "—";
          const queueHint = row.inQueue ? " (queued)" : "";
          return '<tr data-id="' + escapeHtml(id) + '">' +
            '<td class="col-title">' + title + '</td>' +
            '<td class="col-prompt">' + renderPromptCell(id, "prompt", row.prompt) + '</td>' +
            '<td class="col-ai">' + renderPromptCell(id, "aiCreatedPrompt", row.aiCreatedPrompt) + '</td>' +
            '<td class="col-precision">' + escapeHtml(String(precision)) + '</td>' +
            '<td class="col-status"><span class="' + statusClass(status) + '">' +
              escapeHtml(status) + queueHint + '</span></td>' +
            '<td class="col-updated">' + escapeHtml(formatDate(row.updatedAt)) + '</td>' +
            '<td class="col-actions">' +
              '<button type="button" class="btn-sm edit-btn" data-id="' + escapeHtml(id) + '">Edit</button>' +
              '<button type="button" class="btn-sm danger delete-btn" data-id="' + escapeHtml(id) + '" data-title="' + title + '">Delete</button>' +
            '</td></tr>';
        }).join("");
        updateSortIndicators();
      }

      function showLoading() {
        loader.classList.add("show");
        tableWrap.style.display = "none";
        emptyEl.style.display = "none";
        errEl.style.display = "none";
      }

      function showError(msg) {
        loader.classList.remove("show");
        tableWrap.style.display = "none";
        emptyEl.style.display = "none";
        errEl.style.display = "block";
        errEl.textContent = msg;
      }

      function showRows(data) {
        loader.classList.remove("show");
        errEl.style.display = "none";
        rows = data || [];
        if (rows.length === 0) {
          tableWrap.style.display = "none";
          emptyEl.style.display = "block";
          return;
        }
        emptyEl.style.display = "none";
        tableWrap.style.display = "block";
        renderTable();
      }

      document.querySelectorAll(".prompts-table th[data-col]").forEach((th) => {
        th.addEventListener("click", () => {
          const col = th.getAttribute("data-col");
          if (sortCol === col) {
            sortDir = sortDir === "asc" ? "desc" : "asc";
          } else {
            sortCol = col;
            sortDir = col === "updatedAt" ? "desc" : "asc";
          }
          renderTable();
        });
      });

      tbody.addEventListener("click", (e) => {
        const t = e.target;
        if (t.classList.contains("copy-btn")) {
          const rowId = t.getAttribute("data-row-id");
          const field = t.getAttribute("data-field");
          const row = rows.find((r) => String(r._id) === rowId);
          const text = row && field ? String(row[field] || "") : "";
          if (text) {
            vscode.postMessage({ type: "copy", text });
          }
          return;
        }
        if (t.classList.contains("edit-btn")) {
          const id = t.getAttribute("data-id");
          const row = rows.find((r) => String(r._id) === id);
          if (!row) return;
          openModal("edit", row);
          return;
        }
        if (t.classList.contains("delete-btn")) {
          vscode.postMessage({
            type: "delete",
            id: t.getAttribute("data-id"),
            title: t.getAttribute("data-title"),
          });
        }
      });

      $("addPromptBtn").addEventListener("click", () => {
        openModal("create", null);
      });

      $("refreshBtn").addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });

      $("cancelEdit").addEventListener("click", () => {
        closeModal();
      });

      savePromptBtn.addEventListener("click", () => {
        const title = editTitle.value;
        const prompt = editPrompt.value;
        if (modalMode === "create") {
          vscode.postMessage({ type: "saveCreate", title, prompt });
          return;
        }
        if (!editingId) return;
        vscode.postMessage({
          type: "saveEdit",
          id: editingId,
          title,
          prompt,
        });
      });

      modalOverlay.addEventListener("click", (e) => {
        if (e.target === modalOverlay) {
          closeModal();
        }
      });

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "loading") {
          projectName = msg.projectName || "";
          projectTitle.textContent = "Prompts: " + projectName;
          showLoading();
        } else if (msg.type === "prompts") {
          projectName = msg.projectName || projectName;
          projectTitle.textContent = "Prompts: " + projectName;
          showRows(msg.rows);
          closeModal();
        } else if (msg.type === "error") {
          showError("Failed to load prompts: " + escapeHtml(msg.error || "unknown error"));
        } else if (msg.type === "saving") {
          savePromptBtn.disabled = true;
          savePromptBtn.textContent = msg.mode === "create" ? "Creating…" : "Saving…";
        } else if (msg.type === "saveError") {
          resetSaveButton();
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    PromptsPanel.current = undefined;
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
