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

    if (msg.type === "ready" || msg.type === "refresh") {
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
      const promptParameters = String(msg.promptParameters ?? "");
      const skipAiGeneration = msg.skipAiGeneration === true;
      if (!title || !prompt.trim()) {
        vscode.window.showWarningMessage("Anamnesis: title and prompt are required.");
        return;
      }
      try {
        this._panel.webview.postMessage({ type: "saving", mode: "create" });
        await createPrompt(this._projectName, {
          title,
          prompt,
          promptParameters,
          skipAiGeneration,
        });
        vscode.window.showInformationMessage(
          skipAiGeneration
            ? `Anamnesis: prompt "${title}" saved without AI generation.`
            : `Anamnesis: prompt "${title}" created and queued for AI improvement.`
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
      const promptParameters = String(msg.promptParameters ?? "");
      const skipAiGeneration = msg.skipAiGeneration === true;
      if (!id || !title || !prompt.trim()) {
        vscode.window.showWarningMessage("Anamnesis: title and prompt are required.");
        return;
      }
      try {
        this._panel.webview.postMessage({ type: "saving", id, mode: "edit" });
        await updatePrompt(this._projectName, id, {
          title,
          prompt,
          promptParameters,
          skipAiGeneration,
          validateWithAi: !skipAiGeneration,
        });
        vscode.window.showInformationMessage(
          skipAiGeneration
            ? `Anamnesis: prompt "${title}" updated without AI generation.`
            : `Anamnesis: prompt "${title}" updated and queued for AI improvement.`
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
    .table-info, .table-info { padding: 6px 10px; font-size: 11px;
      color: var(--vscode-descriptionForeground, #666);
      background: var(--vscode-sideBar-background, #f5f5f5);
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      position: sticky; top: 0; z-index: 2;
    }
    .prompts-table, .prompts-table { border-collapse: collapse; width: 100%; font-size: 11px;
      table-layout: fixed;
    }
    .prompts-table th, .prompts-table th { text-align: left; padding: 6px 8px; position: sticky; top: 28px;
      background: var(--vscode-sideBar-background, #eee); font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border, #ccc);
      color: var(--vscode-descriptionForeground, #555);
      cursor: pointer; user-select: none; white-space: nowrap; z-index: 1;
    }
    .prompts-table th:hover, .prompts-table th:hover { background: var(--vscode-list-hoverBackground, #e0e0e0); }
    .prompts-table th .sort, .prompts-table th .sort { margin-left: 4px; opacity: 0.6; font-size: 10px; }
    .prompts-table td, .prompts-table td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #eee);
      vertical-align: top; word-break: break-word;
    }
    .prompts-table tr:hover, .prompts-table tr:hover { background: var(--vscode-list-hoverBackground, #f0f0f0); }
    .col-title, .col-title { width: 12%; font-weight: 600; }
    .col-prompt { width: 20%; }
    .col-ai { width: 20%; }
    .col-precision { width: 7%; text-align: center; }
    .col-status { width: 8%; }
    .col-updated { width: 9%; white-space: nowrap; }
    .col-actions { width: 16%; white-space: nowrap; }
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
    #modal, #view-modal, #view-modal { background: var(--vscode-editor-background, #fff);
      border: 1px solid var(--vscode-panel-border, #ccc);
      border-radius: 4px; padding: 16px; width: min(640px, 94vw);
      max-height: 90vh; overflow: auto;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    }
    #view-modal, #view-modal { width: min(720px, 94vw); }
    #modal h2, #view-modal h2, #view-modal h2 { margin: 0 0 12px; font-size: 14px; }
    #modal label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; }
    #modal input:not([type="checkbox"]), #modal textarea { width: 100%; box-sizing: border-box; margin-bottom: 12px;
      padding: 6px 8px; border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #333);
      font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
      text-align: left;
    }
    #modal textarea { min-height: 90px; resize: vertical; }
    #editPromptParameters { min-height: 80px; }
    #modal label.check-row, #modal .check-row {
      display: flex !important; align-items: center; justify-content: flex-start;
      gap: 8px; font-weight: 500; margin: 0 0 4px; text-align: left; width: 100%;
    }
    #modal .check-row input[type="checkbox"] {
      width: 16px !important; min-width: 16px; max-width: 16px; height: 16px;
      margin: 0 !important; padding: 0; flex: none; align-self: center;
    }
    .field-hint { font-size: 11px; font-weight: 400; margin: 0 0 12px;
      color: var(--vscode-descriptionForeground, #888); }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .modal-actions button { padding: 6px 14px; cursor: pointer; border: none; border-radius: 2px;
      background: var(--vscode-button-background, #0a6f0a);
      color: var(--vscode-button-foreground, #fff); font-size: 12px;
    }
    .modal-actions button.secondary {
      background: var(--vscode-button-secondaryBackground, #5a5d5a);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    #view-overlay { display: none; position: fixed; inset: 0; z-index: 110;
      background: rgba(0,0,0,0.45); align-items: center; justify-content: center;
    }
    #view-overlay.show { display: flex !important; }
    .view-section { margin-bottom: 14px; }
    .view-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .view-head h3 { margin: 0; font-size: 12px; font-weight: 600;
      color: var(--vscode-descriptionForeground, #666); }
    .md-preview { border: 1px solid var(--vscode-panel-border, #ccc); border-radius: 3px;
      padding: 10px; max-height: 220px; overflow: auto;
      background: var(--vscode-editor-background, #fff); font-size: 12px; line-height: 1.45; }
    .md-preview h1, .md-preview h2, .md-preview h3 { margin: 0.55em 0 0.3em; }
    .md-preview p { margin: 0 0 0.6em; }
    .md-preview ul, .md-preview ol { margin: 0 0 0.6em; padding-left: 1.4em; }
    .md-preview pre { margin: 0 0 0.6em; padding: 8px; overflow: auto;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); border-radius: 3px; }
    .md-preview code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .md-preview blockquote { margin: 0 0 0.6em; padding-left: 10px;
      border-left: 3px solid var(--vscode-panel-border, #ccc);
      color: var(--vscode-descriptionForeground, #666); }
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
      <label for="editPromptParameters">Prompt Parameters</label>
      <textarea id="editPromptParameters" placeholder="Optional values for placeholders or variables in the prompt"></textarea>
      <p class="field-hint">Use this to fill placeholders in a generic prompt (for example brand, locale, or task constraints).</p>
      <label class="check-row" for="skipAiGeneration">
        <input id="skipAiGeneration" type="checkbox" />
        Skip verification via AI Model
      </label>
      <p class="field-hint">When checked, the original prompt is stored as-is. No AI-generated prompt is created.</p>
      <div class="modal-actions">
        <button type="button" class="secondary" id="cancelEdit">Cancel</button>
        <button type="button" id="savePromptBtn">Save</button>
      </div>
    </div>
  </div>

  <div id="view-overlay">
    <div id="view-modal">
      <h2 id="viewHeading">View Prompt</h2>
      <div class="view-section">
        <div class="view-head">
          <h3>Original Prompt</h3>
          <button type="button" class="btn-sm copy-view-btn" data-field="prompt">Copy</button>
        </div>
        <div id="viewOriginal" class="md-preview"></div>
      </div>
      <div class="view-section">
        <div class="view-head">
          <h3>AI Generated Prompt</h3>
          <button type="button" class="btn-sm copy-view-btn" data-field="aiCreatedPrompt">Copy</button>
        </div>
        <div id="viewAi" class="md-preview"></div>
      </div>
      <div class="view-section">
        <div class="view-head">
          <h3>Prompt Parameters</h3>
          <button type="button" class="btn-sm copy-view-btn" data-field="promptParameters">Copy</button>
        </div>
        <div id="viewParameters" class="md-preview"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="closeView">Close</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    try {
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
      const tableInfo = $("table-info") || $("table-info");
      const emptyEl = $("empty");
      const errEl = $("err");
      const projectTitle = $("projectTitle");
      const modalOverlay = $("modal-overlay");
      const modalHeading = $("modalHeading");
      const editTitle = $("editTitle");
      const editPrompt = $("editPrompt");
      const savePromptBtn = $("savePromptBtn");
      const editPromptParameters = $("editPromptParameters");
      const skipAiGeneration = $("skipAiGeneration");
      const viewOverlay = $("view-overlay");
      const viewOriginal = $("viewOriginal");
      const viewAi = $("viewAi");
      const viewParameters = $("viewParameters");
      let viewingRow = null;

      function saveButtonLabel() {
        const skip = !!(skipAiGeneration && skipAiGeneration.checked);
        if (modalMode === "create") {
          return skip ? "Save Prompt" : "Create Prompt";
        }
        return skip ? "Save Prompt" : "Save & Re-validate with AI";
      }

      function updateSaveLabel() {
        savePromptBtn.disabled = false;
        savePromptBtn.textContent = saveButtonLabel();
      }

      function openModal(mode, row) {
        modalMode = mode;
        editingId = mode === "edit" && row ? String(row._id ?? "") : null;
        editTitle.value = row ? (row.title || "") : "";
        editPrompt.value = row ? (row.prompt || "") : "";
        editPromptParameters.value = row ? (row.promptParameters || "") : "";
        skipAiGeneration.checked = false;
        modalHeading.textContent = mode === "create" ? "Add Prompt" : "Edit Prompt";
        updateSaveLabel();
        modalOverlay.classList.add("show");
        editTitle.focus();
      }

      function closeModal() {
        modalOverlay.classList.remove("show");
        editingId = null;
        modalMode = "edit";
      }

      function closeView() {
        if (viewOverlay) {
          viewOverlay.classList.remove("show");
          viewOverlay.style.display = "none";
        }
        viewingRow = null;
      }

      function resetSaveButton() {
        updateSaveLabel();
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }

      function nl() { return String.fromCharCode(10); }
      function cr() { return String.fromCharCode(13); }
      function star() { return String.fromCharCode(42); }

      function renderInline(text) {
        var tick = String.fromCharCode(96);
        var s = escapeHtml(text);
        s = s.replace(new RegExp(tick + "([^" + tick + "]+)" + tick, "g"), "<code>$1</code>");
        var bold = star() + star();
        s = s.replace(new RegExp(bold + "([^*]+)" + bold, "g"), "<strong>$1</strong>");
        s = s.replace(new RegExp(star() + "([^*]+)" + star(), "g"), "<em>$1</em>");
        return s;
      }

      function renderMarkdown(src) {
        var tick = String.fromCharCode(96);
        var fence = tick + tick + tick;
        var raw = String(src || "").split(cr() + nl()).join(nl()).split(cr()).join(nl());
        if (!raw.trim()) return '<p class="cell-empty">—</p>';
        var lines = raw.split(nl());
        var html = [];
        var i = 0;
        var para = [];
        var ulRe = new RegExp("^[ \\t]*[-+" + star() + "][ \\t]+");
        var olRe = new RegExp("^[ \\t]*[0-9]+[.][ \\t]+");
        var hRe = new RegExp("^(#{1,6})[ \\t]+(.+)$");
        var bqRe = new RegExp("^>[ \\t]?");
        var hrRe = new RegExp("^([ \\t]*[-_" + star() + "][ \\t]*){3,}$");
        function flushPara() {
          if (para.length) {
            html.push("<p>" + renderInline(para.join(" ")) + "</p>");
            para = [];
          }
        }
        function flushList(kind, items) {
          if (!items.length) return;
          var tag = kind === "ol" ? "ol" : "ul";
          html.push("<" + tag + ">" + items.map(function (it) {
            return "<li>" + renderInline(it) + "</li>";
          }).join("") + "</" + tag + ">");
        }
        while (i < lines.length) {
          var line = lines[i];
          if (line.indexOf(fence) === 0) {
            flushPara();
            i++;
            var code = [];
            while (i < lines.length && lines[i].indexOf(fence) !== 0) {
              code.push(lines[i]);
              i++;
            }
            if (i < lines.length) i++;
            html.push("<pre><code>" + escapeHtml(code.join(nl())) + "</code></pre>");
            continue;
          }
          if (ulRe.test(line)) {
            flushPara();
            var items = [];
            while (i < lines.length && ulRe.test(lines[i])) {
              items.push(lines[i].replace(ulRe, ""));
              i++;
            }
            flushList("ul", items);
            continue;
          }
          if (olRe.test(line)) {
            flushPara();
            var oitems = [];
            while (i < lines.length && olRe.test(lines[i])) {
              oitems.push(lines[i].replace(olRe, ""));
              i++;
            }
            flushList("ol", oitems);
            continue;
          }
          var hm = hRe.exec(line);
          if (hm) {
            flushPara();
            var level = hm[1].length;
            html.push("<h" + level + ">" + renderInline(hm[2]) + "</h" + level + ">");
            i++;
            continue;
          }
          if (bqRe.test(line)) {
            flushPara();
            var bq = [];
            while (i < lines.length && bqRe.test(lines[i])) {
              bq.push(lines[i].replace(bqRe, ""));
              i++;
            }
            html.push("<blockquote>" + renderInline(bq.join(" ")) + "</blockquote>");
            continue;
          }
          if (hrRe.test(line)) {
            flushPara();
            html.push("<hr />");
            i++;
            continue;
          }
          if (!line.trim()) {
            flushPara();
            i++;
            continue;
          }
          para.push(line);
          i++;
        }
        flushPara();
        return html.join("") || '<p class="cell-empty">—</p>';
      }

      function mdOrText(value) {
        try {
          return renderMarkdown(value);
        } catch (err) {
          return "<pre>" + escapeHtml(String(value || "")) + "</pre>";
        }
      }

      function openView(row) {
        if (!row || !viewOverlay) return;
        viewingRow = row;
        viewOverlay.classList.add("show");
        viewOverlay.style.display = "flex";
        try {
          if (viewOriginal) viewOriginal.innerHTML = mdOrText(row.prompt);
          var status = String(row.status || "");
          if (viewAi) {
            if (status === "processing" || row.inQueue) {
              viewAi.innerHTML = '<p class="cell-empty">AI generation is still processing. Refresh to check.</p>';
            } else if (status === "failed") {
              viewAi.innerHTML = '<p class="cell-empty">' + escapeHtml(row.aiError || "AI processing failed.") + "</p>";
            } else {
              viewAi.innerHTML = mdOrText(row.aiCreatedPrompt);
            }
          }
          if (viewParameters) viewParameters.innerHTML = mdOrText(row.promptParameters);
        } catch (err) {
          if (errEl) {
            errEl.style.display = "block";
            errEl.textContent = "Failed to open prompt: " +
              (err && err.message ? err.message : String(err));
          }
        }
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
        if (tableInfo) {
          tableInfo.textContent = sorted.length + " prompt(s) · click column headers to sort";
        }
        tbody.innerHTML = sorted.map((row) => {
          const id = String(row._id ?? row.id ?? "");
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
              '<button type="button" class="btn-sm view-btn" data-id="' + escapeHtml(id) + '">View</button>' +
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

      if (tbody) {
      tbody.addEventListener("click", (e) => {
        const t = e.target && e.target.closest ? e.target.closest("button") : e.target;
        if (!t || !t.classList) return;
        if (t.classList.contains("copy-btn")) {
          const rowId = t.getAttribute("data-row-id");
          const field = t.getAttribute("data-field");
          const row = rows.find((r) => String(r._id ?? r.id) === rowId);
          const text = row && field ? String(row[field] || "") : "";
          if (text) {
            vscode.postMessage({ type: "copy", text });
          }
          return;
        }
        if (t.classList.contains("view-btn")) {
          const id = t.getAttribute("data-id");
          const row = rows.find((r) => String(r._id ?? r.id) === id);
          if (!row) return;
          openView(row);
          return;
        }
        if (t.classList.contains("edit-btn")) {
          const id = t.getAttribute("data-id");
          const row = rows.find((r) => String(r._id ?? r.id) === id);
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
      }

      var addPromptBtn = $("addPromptBtn") || $("addPromptBtn");
      if (addPromptBtn) {
        addPromptBtn.addEventListener("click", () => {
          openModal("create", null);
        });
      }

      var refreshBtn = $("refreshBtn") || $("refreshBtn");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          vscode.postMessage({ type: "refresh" });
        });
      }

      var cancelEdit = $("cancelEdit");
      if (cancelEdit) {
        cancelEdit.addEventListener("click", () => {
          closeModal();
        });
      }

      if (savePromptBtn) {
        savePromptBtn.addEventListener("click", () => {
          const title = editTitle.value;
          const prompt = editPrompt.value;
          const promptParameters = editPromptParameters.value;
          const skip = !!(skipAiGeneration && skipAiGeneration.checked);
          if (modalMode === "create") {
            vscode.postMessage({ type: "saveCreate", title, prompt, promptParameters, skipAiGeneration: skip });
            return;
          }
          if (!editingId) return;
          vscode.postMessage({
            type: "saveEdit",
            id: editingId,
            title,
            prompt,
            promptParameters,
            skipAiGeneration: skip,
          });
        });
      }

      if (skipAiGeneration) {
        skipAiGeneration.addEventListener("change", () => {
          updateSaveLabel();
        });
      }

      var closeViewBtn = $("closeView");
      if (closeViewBtn) {
        closeViewBtn.addEventListener("click", () => {
          closeView();
        });
      }

      if (viewOverlay) {
        viewOverlay.addEventListener("click", (e) => {
          if (e.target === viewOverlay) {
            closeView();
          }
        });
        viewOverlay.addEventListener("click", (e) => {
          const t = e.target;
          if (!t.classList || !t.classList.contains("copy-view-btn")) return;
          const field = t.getAttribute("data-field");
          const text = viewingRow && field ? String(viewingRow[field] || "") : "";
          if (text) {
            vscode.postMessage({ type: "copy", text });
          }
        });
      }

      if (modalOverlay) {
        modalOverlay.addEventListener("click", (e) => {
          if (e.target === modalOverlay) {
            closeModal();
          }
        });
      }

      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "loading") {
          projectName = msg.projectName || "";
          if (projectTitle) projectTitle.textContent = "Prompts: " + projectName;
          showLoading();
        } else if (msg.type === "prompts") {
          projectName = msg.projectName || projectName;
          if (projectTitle) projectTitle.textContent = "Prompts: " + projectName;
          showRows(msg.rows);
          closeModal();
          closeView();
        } else if (msg.type === "error") {
          showError("Failed to load prompts: " + escapeHtml(msg.error || "unknown error"));
        } else if (msg.type === "saving") {
          if (savePromptBtn) {
            savePromptBtn.disabled = true;
            savePromptBtn.textContent = msg.mode === "create" ? "Creating…" : "Saving…";
          }
        } else if (msg.type === "saveError") {
          resetSaveButton();
        }
      });
      vscode.postMessage({ type: "ready" });
    })();
    } catch (bootErr) {
      var errBox = document.getElementById("err");
      if (errBox) {
        errBox.style.display = "block";
        errBox.textContent = "Prompts panel failed to start: " +
          (bootErr && bootErr.message ? bootErr.message : String(bootErr));
      }
    }
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
