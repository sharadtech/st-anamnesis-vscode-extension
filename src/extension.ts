import * as vscode from "vscode";
import { GraphPanel } from "./graphPanel";
import { SettingsPanel } from "./settingsPanel";
import { fetchProjects, deleteGraph, config } from "./api";

// ---- TreeView data provider for the Projects view in the Activity Bar ----

class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: string,
    public readonly label: string,
    public readonly detail: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "project";
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon("repo");
    this.tooltip = `Project: ${label}\nTag: ${tag}\n${detail}`;
    this.command = {
      command: "anamnesis.openGraphForTag",
      title: "Open Graph",
      arguments: [tag],
    };
  }
}

class ProjectsProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private items: ProjectTreeItem[] = [];

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: ProjectTreeItem): ProjectTreeItem {
    return element;
  }

  async getChildren(element?: ProjectTreeItem): Promise<ProjectTreeItem[]> {
    if (element) {
      return [];
    }
    const { serverUrl, defaultTag } = config();
    if (!serverUrl) {
      // Surface missing URL in the tree so the user notices before opening settings.
      const empty = new ProjectTreeItem(
        defaultTag,
        "Configure server URL",
        "Set anamnesis.serverUrl in Settings"
      );
      empty.iconPath = new vscode.ThemeIcon("warning");
      this.items = [empty];
      return [empty];
    }
    try {
      const { projects } = await fetchProjects();
      // Only list graphs (project_name with nodes), and dedupe by tag.
      const seen = new Set<string>();
      const items: ProjectTreeItem[] = [];
      for (const p of projects) {
        const tag = (p.graph_tag as string) || (p.project_name as string);
        if (!tag || seen.has(tag)) continue;
        if (typeof p.nodes !== "number") continue; // skip meta-only entries
        seen.add(tag);
        const nodes = p.nodes as number;
        const edges = p.edges as number;
        const commit = p.built_at_commit ? String(p.built_at_commit).slice(0, 8) : "-";
        items.push(
          new ProjectTreeItem(tag, tag, `${nodes}n / ${edges}e / ${commit}`)
        );
      }
      // Ensure the default graph appears even if not in metas.
      if (!seen.has(defaultTag)) {
        items.push(new ProjectTreeItem(defaultTag, defaultTag, "(default)"));
      }
      this.items = items;
      return items;
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: could not load projects: ${err instanceof Error ? err.message : err}`
      );
      return [];
    }
  }
}

let projectsProvider: ProjectsProvider;

export function activate(context: vscode.ExtensionContext): void {
  projectsProvider = new ProjectsProvider();
  const treeView = vscode.window.createTreeView("anamnesis.projects", {
    treeDataProvider: projectsProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Anamnesis: Open Knowledge Graph (pick a tag via QuickPick)
  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openGraph", async () => {
      const tag = await pickTag();
      if (tag) {
        await GraphPanel.createOrShow(context.extensionUri, tag);
      }
    })
  );

  // Anamnesis: Open Graph for Project (from the tree, or direct call with arg)
  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openGraphForTag", async (tag?: string) => {
      const t = tag || (await pickTag());
      if (t) {
        await GraphPanel.createOrShow(context.extensionUri, t);
      }
    })
  );

  // Anamnesis: View in Knowledge Graph (Explorer context menu on a file)
  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openGraphForFile", async (uri?: vscode.Uri) => {
      const relPath = relativizeUri(uri);
      const tag = await pickTag();
      if (tag) {
        await GraphPanel.createOrShow(context.extensionUri, tag, relPath);
      }
    })
  );

  // Anamnesis: Refresh Projects
  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.refresh", () => {
      projectsProvider.refresh();
    })
  );

  // Anamnesis: Open Settings (graphical config editor for URL / API key / default tag)
  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openSettings", () => {
      SettingsPanel.createOrShow(context.extensionUri);
    })
  );

  // Anamnesis: Delete Project Graph (from the tree, with confirmation).
  // Refuses to delete the 'default' tag (server-side enforced too).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.deleteProject",
      async (item?: ProjectTreeItem | string) => {
        const tag = typeof item === "string" ? item : item?.tag;
        if (!tag) {
          return;
        }
        if (tag === "default") {
          vscode.window.showWarningMessage(
            "Anamnesis: the 'default' graph cannot be deleted (it is shared by the query tools)."
          );
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete the knowledge graph for "${tag}" from the remote Anamnesis Server?\nThis removes graph:${tag}, meta:${tag}, and meta:jenkins:${tag}. This cannot be undone.`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          const res = await deleteGraph(tag);
          vscode.window.showInformationMessage(
            `Anamnesis: deleted ${tag} (removed: ${res.deleted.join(", ") || "nothing"}).`
          );
          projectsProvider.refresh();
          if (GraphPanel.current && GraphPanel.current.tag === tag) {
            GraphPanel.current.dispose();
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Anamnesis: delete failed: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    )
  );

  // Reload the panel if config changes (server URL changed).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("anamnesis")) {
        projectsProvider.refresh();
        if (GraphPanel.current) {
          GraphPanel.current.refresh();
        }
      }
    })
  );
}

async function pickTag(): Promise<string | undefined> {
  const { serverUrl, defaultTag } = config();
  if (!serverUrl) {
    vscode.window.showWarningMessage(
      "Anamnesis: no server URL is configured. Open the Anamnesis Settings panel to set one."
    );
    return undefined;
  }
  try {
    const { projects } = await fetchProjects();
    const seen = new Set<string>();
    const tags: { label: string; description: string }[] = [];
    for (const p of projects) {
      const tag = (p.graph_tag as string) || (p.project_name as string);
      if (!tag || seen.has(tag) || typeof p.nodes !== "number") continue;
      seen.add(tag);
      tags.push({
        label: tag,
        description: `${p.nodes}n / ${p.edges}e`,
      });
    }
    if (!seen.has(defaultTag)) {
      tags.push({ label: defaultTag, description: "(default)" });
    }
    if (tags.length === 0) {
      tags.push({ label: defaultTag, description: "(default)" });
    }
    const picked = await vscode.window.showQuickPick(tags, {
      placeHolder: "Select a project graph to open",
    });
    return picked?.label;
  } catch {
    return defaultTag;
  }
}

function relativizeUri(uri?: vscode.Uri): string | undefined {
  if (!uri) return undefined;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    return rel;
  }
  return uri.fsPath;
}

export function deactivate(): void {
  if (GraphPanel.current) {
    GraphPanel.current.dispose();
  }
}
