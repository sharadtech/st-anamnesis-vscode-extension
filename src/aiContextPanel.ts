import * as vscode from "vscode";
import { fetchAiContext, saveAiContext, updateAiContext } from "./api";

export type AiContextPanelMode = "view" | "edit";

const MERMAID_EXTENSION_IDS = [
  "bierner.markdown-mermaid",
  "mermaidchart.vscode-mermaid-chart",
  "vstirbu.vscode-mermaid-preview",
  "tomoyukim.vscode-mermaid-editor",
  "bpruitt-goddard.mermaid-markdown-syntax-highlighting",
];

export class AiContextPanel {
  public static current: AiContextPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _recordId: string | undefined;
  private _mode: AiContextPanelMode = "edit";
  private _onSaved: (() => void) | undefined;

  private constructor(panel: vscode.WebviewPanel, recordId: string | undefined, mode: AiContextPanelMode) {
    this._panel = panel;
    this._recordId = recordId;
    this._mode = mode;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables
    );
  }

  public static async createOrShow(
    extensionUri: vscode.Uri,
    recordId: string | undefined,
    mode: AiContextPanelMode,
    onSaved?: () => void
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
    if (AiContextPanel.current) {
      AiContextPanel.current._recordId = recordId;
      AiContextPanel.current._mode = mode;
      AiContextPanel.current._onSaved = onSaved;
      AiContextPanel.current._panel.reveal(column);
      AiContextPanel.current._render(extensionUri);
      await AiContextPanel.current._load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "anamnesisAiContext",
      mode === "view" ? "AI Context" : recordId ? "Edit AI Context" : "New AI Context",
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    AiContextPanel.current = new AiContextPanel(panel, recordId, mode);
    AiContextPanel.current._onSaved = onSaved;
    AiContextPanel.current._render(extensionUri);
    await AiContextPanel.current._load();
  }

  private async _load(): Promise<void> {
    if (this._mode === "edit" && !this._recordId) {
      this._panel.title = "New AI Context";
      this._panel.webview.postMessage({ type: "record", projectName: "", context: "" });
      return;
    }
    if (!this._recordId) {
      return;
    }
    try {
      const row = await fetchAiContext(this._recordId);
      const projectName = row.projectName || "";
      const context = row.context || "";
      if (this._mode === "view") {
        this._panel.title = projectName || "AI Context";
        const rendered = renderMarkdown(context);
        this._panel.webview.postMessage({
          type: "view",
          projectName,
          html: rendered.html,
          mermaid: rendered.hasMermaid && mermaidExtensionInstalled(),
          mermaidSkipped: rendered.hasMermaid && !mermaidExtensionInstalled(),
        });
        return;
      }
      this._panel.title = "Edit AI Context";
      this._panel.webview.postMessage({ type: "record", projectName, context });
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
    const mermaid = this._mode === "view" && mermaidExtensionInstalled();
    const csp = mermaid
      ? `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; worker-src blob:;`
      : `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const mermaidScript = mermaid
      ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js"></script>`
      : "";
    const body = this._mode === "view" ? viewBody() : editBody();
    const script = this._mode === "view" ? viewScript(mermaid) : editScript();
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Context</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { max-width: 860px; margin: 20px auto; padding: 0 20px 48px; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 16px; }
    .md h1, .md h2, .md h3 { margin: 1.1em 0 0.4em; }
    .md p { line-height: 1.5; }
    .md pre { overflow: auto; padding: 10px 12px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); }
    .md code { font-family: var(--vscode-editor-font-family, monospace); }
    .md ul, .md ol { padding-left: 1.4em; }
    .md blockquote { margin: 0.6em 0; padding-left: 12px; border-left: 3px solid var(--vscode-textBlockQuote-border, #888); }
    .md table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
    .md th, .md td { border: 1px solid var(--vscode-panel-border, #444); padding: 6px 8px; vertical-align: top; text-align: left; }
    .md th { background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,0.2)); font-weight: 600; }
    .md td.align-center, .md th.align-center { text-align: center; }
    .md td.align-right, .md th.align-right { text-align: right; }
    .md .table-wrap { overflow-x: auto; }
    .note { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 16px; }
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
    .mermaid { margin: 12px 0; }
  </style>
  ${mermaidScript}
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
  <script nonce="${nonce}">
    ${script}
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

function viewBody(): string {
  return `<h1 id="title"></h1>
    <div id="md" class="md"></div>
    <div id="note" class="note"></div>`;
}

function editBody(): string {
  return `<h1>AI Context</h1>
    <div class="sub">Save project context for the Anamnesis agent. The project name is the key used later to fetch this text.</div>
    <label for="projectName">Project name</label>
    <input id="projectName" type="text" placeholder="st-ck-client" />
    <label for="aiContext">AI Context</label>
    <textarea id="aiContext" placeholder="Architecture notes, conventions, and constraints the agent should follow for this project."></textarea>
    <div class="row">
      <button id="saveBtn">Save</button>
      <button id="cancelBtn" class="secondary">Cancel</button>
    </div>
    <div id="status" class="status"></div>`;
}

function viewScript(mermaid: boolean): string {
  const runMermaid = mermaid
    ? `if (msg.mermaid && window.mermaid) {
            const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
            window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: dark ? "dark" : "default" });
            window.mermaid.run({ querySelector: ".mermaid" });
          }`
    : "";
  return `(function () {
      const title = document.getElementById("title");
      const md = document.getElementById("md");
      const note = document.getElementById("note");
      window.addEventListener("message", function (event) {
        const msg = event.data;
        if (!msg || msg.type !== "view") return;
        title.textContent = msg.projectName || "";
        md.innerHTML = msg.html || "";
        note.textContent = msg.mermaidSkipped
          ? "Mermaid diagrams are shown as code. Install a Mermaid markdown extension to render them."
          : "";
        ${runMermaid}
      });
    })();`;
}

function editScript(): string {
  return `(function () {
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
    })();`;
}

function mermaidExtensionInstalled(): boolean {
  return MERMAID_EXTENSION_IDS.some((id) => !!vscode.extensions.getExtension(id));
}

function renderMarkdown(source: string): { html: string; hasMermaid: boolean } {
  const mermaidBlocks: string[] = [];
  const codeBlocks: string[] = [];
  let text = source.replace(/\r\n/g, "\n");
  text = text.replace(/```mermaid[ \t]*\n([\s\S]*?)```/g, (_m, body: string) => {
    mermaidBlocks.push(String(body).replace(/\n$/, ""));
    return `\n\n@@MERMAID${mermaidBlocks.length - 1}@@\n\n`;
  });
  text = text.replace(/```([a-zA-Z0-9_-]*)[ \t]*\n([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const label = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${label}>${escapeHtml(String(body).replace(/\n$/, ""))}</code></pre>`);
    return `\n\n@@CODE${codeBlocks.length - 1}@@\n\n`;
  });
  const lines = escapeHtml(text).split("\n");
  const out: string[] = [];
  let i = 0;
  const flushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    out.push(`<p>${inlineMarkdown(buf.join(" "))}</p>`);
    buf.length = 0;
  };
  const paragraph: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const mermaid = /^@@MERMAID(\d+)@@$/.exec(line.trim());
    const code = /^@@CODE(\d+)@@$/.exec(line.trim());
    if (mermaid) {
      flushParagraph(paragraph);
      const raw = mermaidBlocks[Number(mermaid[1])] || "";
      out.push(`<div class="mermaid">${escapeHtml(raw)}</div>`);
      i += 1;
      continue;
    }
    if (code) {
      flushParagraph(paragraph);
      out.push(codeBlocks[Number(code[1])] || "");
      i += 1;
      continue;
    }
    if (!line.trim()) {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length + 1;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      flushParagraph(paragraph);
      out.push("<hr>");
      i += 1;
      continue;
    }
    if (line.startsWith("&gt; ")) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith("&gt; ")) {
        quote.push(lines[i].slice(5));
        i += 1;
      }
      out.push(`<blockquote><p>${inlineMarkdown(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      flushParagraph(paragraph);
      const ordered = /^\d+\. /.test(line);
      const items: string[] = [];
      const pattern = ordered ? /^\d+\. (.*)$/ : /^[-*] (.*)$/;
      while (i < lines.length && pattern.test(lines[i])) {
        const match = pattern.exec(lines[i]);
        items.push(`<li>${inlineMarkdown(match ? match[1] : "")}</li>`);
        i += 1;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (isMarkdownTableStart(lines, i)) {
      flushParagraph(paragraph);
      const headers = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(tableAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(headers, align, rows));
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph(paragraph);
  return { html: out.join("\n"), hasMermaid: mermaidBlocks.length > 0 };
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const header = lines[index] || "";
  const separator = lines[index + 1] || "";
  if (!isTableRow(header) || !isTableSeparator(separator)) {
    return false;
  }
  const headerCount = splitTableRow(header).length;
  return headerCount > 0 && splitTableRow(separator).length === headerCount;
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|") && !/^:?-{3,}:?$/.test(line.trim())) {
    return false;
  }
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/\\\|/g, "@@PIPE@@");
  let cells = trimmed.split("|").map((cell) => cell.replace(/@@PIPE@@/g, "|").trim());
  if (trimmed.startsWith("|")) {
    cells = cells.slice(1);
  }
  if (trimmed.endsWith("|")) {
    cells = cells.slice(0, -1);
  }
  return cells;
}

function tableAlign(cell: string): "left" | "center" | "right" {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function renderTable(headers: string[], align: Array<"left" | "center" | "right">, rows: string[][]): string {
  const width = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const head = Array.from({ length: width }, (_, col) => {
    const cls = align[col] && align[col] !== "left" ? ` class="align-${align[col]}"` : "";
    return `<th${cls}>${inlineMarkdown(headers[col] || "")}</th>`;
  }).join("");
  const body = rows
    .map((row) => {
      const cells = Array.from({ length: width }, (_, col) => {
        const cls = align[col] && align[col] !== "left" ? ` class="align-${align[col]}"` : "";
        return `<td${cls}>${inlineMarkdown(row[col] || "")}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function inlineMarkdown(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
