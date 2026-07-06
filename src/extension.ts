import * as path from "path";
import * as vscode from "vscode";
import { GraphPanel } from "./graphPanel";
import { SettingsPanel } from "./settingsPanel";
import { PromptsPanel } from "./promptsPanel";
import { fetchProjects, fetchAuthUser, deleteGraph, config, AuthUser } from "./api";
import { generateAndUpload } from "./generate";
import { registerAiTools, unregisterAiTools, syncAiToolsSilently } from "./aiTools";

const AI_TOOLS_DISABLED_KEY = "anamnesis.aiToolsDisabled";

// ---- TreeView data provider for the Projects view in the Activity Bar ----

class UserHeaderTreeItem extends vscode.TreeItem {
  constructor(user: AuthUser) {
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    const label = fullName || user.email || user.userId;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "userHeader";
    this.iconPath = new vscode.ThemeIcon("account");
    this.description = [user.role, user.keyName ? `key: ${user.keyName}` : ""]
      .filter(Boolean)
      .join(" · ");
    const lines = [
      fullName ? `Name: ${fullName}` : "",
      user.email ? `Email: ${user.email}` : "",
      `Role: ${user.role}`,
      user.keyName ? `API key: ${user.keyName}` : "",
      `User Id: ${user.userId}`,
    ].filter(Boolean);
    this.tooltip = lines.join("\n");
  }
}

class MessageTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: string,
    label: string,
    detail: string,
    icon: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "message";
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: string,
    public readonly shared: boolean,
    label: string,
    detail: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = shared ? "sharedProject" : "ownedProject";
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon(shared ? "cloud-download" : "repo");
    this.tooltip = `Project: ${label}\nTag: ${tag}\n${detail}${shared ? "\nShared (read-only)" : ""}`;
    this.command = {
      command: "anamnesis.openGraphForTag",
      title: "Open Graph",
      arguments: [tag],
    };
  }
}

class ProjectPromptTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: string,
    label: string,
    detail: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "promptProject";
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.tooltip = `Project: ${label}\nTag: ${tag}\nClick to view prompts`;
    this.command = {
      command: "anamnesis.openProjectPrompts",
      title: "Open Project Prompts",
      arguments: [tag],
    };
  }
}

type AnamnesisTreeItem = UserHeaderTreeItem | MessageTreeItem | ProjectTreeItem;
type ProjectPromptsTreeItem = MessageTreeItem | ProjectPromptTreeItem;

class ProjectsProvider implements vscode.TreeDataProvider<AnamnesisTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: AnamnesisTreeItem): AnamnesisTreeItem {
    return element;
  }

  async getChildren(element?: AnamnesisTreeItem): Promise<AnamnesisTreeItem[]> {
    if (element) {
      return [];
    }
    const { serverUrl, clientId, secretKey } = config();
    if (!serverUrl || !clientId || !secretKey) {
      return [
        new MessageTreeItem(
          "configure",
          "Configure Anamnesis",
          "Set Client Id and Secret Key in Anamnesis Settings",
          "warning"
        ),
      ];
    }

    let user: AuthUser | undefined;
    try {
      user = await fetchAuthUser();
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: authentication failed: ${err instanceof Error ? err.message : err}`
      );
      return [
        new MessageTreeItem(
          "auth-failed",
          "Authentication failed",
          "Check Client Id and Secret Key in Anamnesis Settings",
          "error"
        ),
      ];
    }

    const items: AnamnesisTreeItem[] = [new UserHeaderTreeItem(user)];

    try {
      const { projects } = await fetchProjects();
      const seen = new Set<string>();
      for (const p of projects) {
        const tag = (p.graph_tag as string) || (p.project_name as string);
        if (!tag || seen.has(tag)) continue;
        if (typeof p.nodes !== "number") continue;
        seen.add(tag);
        const nodes = p.nodes as number;
        const edges = p.edges as number;
        const commit = p.built_at_commit ? String(p.built_at_commit).slice(0, 8) : "-";
        const shared = p.shared === true;
        const stats = `${nodes}n / ${edges}e / ${commit}`;
        const detail = shared ? `${stats} · shared` : stats;
        items.push(new ProjectTreeItem(tag, shared, tag, detail));
      }
      if (items.length === 1) {
        items.push(
          new MessageTreeItem(
            "none",
            "No projects yet",
            "Right-click a folder → Create Knowledge Graph",
            "info"
          )
        );
      }
      return items;
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: could not load projects: ${err instanceof Error ? err.message : err}`
      );
      items.push(
        new MessageTreeItem(
          "load-failed",
          "Could not load projects",
          err instanceof Error ? err.message : String(err),
          "error"
        )
      );
      return items;
    }
  }
}

class ProjectPromptsProvider implements vscode.TreeDataProvider<ProjectPromptsTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: ProjectPromptsTreeItem): ProjectPromptsTreeItem {
    return element;
  }

  async getChildren(element?: ProjectPromptsTreeItem): Promise<ProjectPromptsTreeItem[]> {
    if (element) {
      return [];
    }
    const { serverUrl, clientId, secretKey } = config();
    if (!serverUrl || !clientId || !secretKey) {
      return [
        new MessageTreeItem(
          "configure",
          "Configure Anamnesis",
          "Set Client Id and Secret Key in Anamnesis Settings",
          "warning"
        ),
      ];
    }

    try {
      await fetchAuthUser();
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: authentication failed: ${err instanceof Error ? err.message : err}`
      );
      return [
        new MessageTreeItem(
          "auth-failed",
          "Authentication failed",
          "Check Client Id and Secret Key in Anamnesis Settings",
          "error"
        ),
      ];
    }

    try {
      const { projects } = await fetchProjects();
      const seen = new Set<string>();
      const items: ProjectPromptsTreeItem[] = [];
      for (const p of projects) {
        const tag = (p.graph_tag as string) || (p.project_name as string);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        const shared = p.shared === true;
        const detail = shared ? "shared project" : "view prompts";
        items.push(new ProjectPromptTreeItem(tag, tag, detail));
      }
      if (items.length === 0) {
        items.push(
          new MessageTreeItem(
            "none",
            "No projects yet",
            "Create a knowledge graph first",
            "info"
          )
        );
      }
      return items;
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: could not load projects: ${err instanceof Error ? err.message : err}`
      );
      return [
        new MessageTreeItem(
          "load-failed",
          "Could not load projects",
          err instanceof Error ? err.message : String(err),
          "error"
        ),
      ];
    }
  }
}

let projectsProvider: ProjectsProvider;
let projectPromptsProvider: ProjectPromptsProvider;

export function activate(context: vscode.ExtensionContext): void {
  projectsProvider = new ProjectsProvider();
  const treeView = vscode.window.createTreeView("anamnesis.projects", {
    treeDataProvider: projectsProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  projectPromptsProvider = new ProjectPromptsProvider();
  const promptsTreeView = vscode.window.createTreeView("anamnesis.projectPrompts", {
    treeDataProvider: projectPromptsProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(promptsTreeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openGraph", async () => {
      const tag = await pickTag();
      if (tag) {
        await GraphPanel.createOrShow(context.extensionUri, tag);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openGraphForTag", async (tag?: string) => {
      const t = tag || (await pickTag());
      if (t) {
        await GraphPanel.createOrShow(context.extensionUri, t);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openGraphForFile", async (uri?: vscode.Uri) => {
      const relPath = relativizeUri(uri);
      const tag = await pickTag();
      if (tag) {
        await GraphPanel.createOrShow(context.extensionUri, tag, relPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.refresh", () => {
      projectsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.refreshPrompts", () => {
      projectPromptsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openProjectPrompts", async (tag?: string) => {
      if (!tag) {
        vscode.window.showWarningMessage("Anamnesis: no project selected.");
        return;
      }
      await PromptsPanel.createOrShow(context.extensionUri, tag);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openSettings", () => {
      SettingsPanel.createOrShow(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.createGraph", async (uri?: vscode.Uri) => {
      const folderUri = await resolveFolderUri(uri);
      if (!folderUri) {
        return;
      }
      try {
        const projectName = await generateAndUpload(folderUri, context.extensionPath);
        projectsProvider.refresh();
        const view = await vscode.window.showInformationMessage(
          `Anamnesis: knowledge graph created for "${projectName}".`,
          "View Knowledge Graph"
        );
        if (view === "View Knowledge Graph") {
          await GraphPanel.createOrShow(context.extensionUri, projectName);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: create failed: ${err instanceof Error ? err.message : err}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.viewGraph", async (uri?: vscode.Uri) => {
      const folderUri = await resolveFolderUri(uri);
      if (!folderUri) {
        return;
      }
      const projectName = path.basename(folderUri.fsPath);
      await GraphPanel.createOrShow(context.extensionUri, projectName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.viewPrompts", async (uri?: vscode.Uri) => {
      const folderUri = await resolveFolderUri(uri);
      if (!folderUri) {
        return;
      }
      const projectName = path.basename(folderUri.fsPath);
      await PromptsPanel.createOrShow(context.extensionUri, projectName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.deleteProject",
      async (item?: ProjectTreeItem | string) => {
        const tag = typeof item === "string" ? item : item?.tag;
        if (!tag || tag === "configure" || tag === "none") {
          return;
        }
        if (item instanceof ProjectTreeItem && item.shared) {
          vscode.window.showWarningMessage(
            `Anamnesis: "${tag}" is a shared project and cannot be deleted.`
          );
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete the knowledge graph for "${tag}" from Anamnesis Cloud?\nThis removes the graph from Redis and the repository record. This cannot be undone.`,
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

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.registerAiTools", async () => {
      await context.globalState.update(AI_TOOLS_DISABLED_KEY, false);
      await runRegisterAiTools();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.unregisterAiTools", async () => {
      try {
        await context.globalState.update(AI_TOOLS_DISABLED_KEY, true);
        const res = unregisterAiTools();
        if (!res.mcpRemoved && !res.skillRemoved) {
          vscode.window.showInformationMessage("Anamnesis: AI tools were not registered.");
          return;
        }
        vscode.window.showInformationMessage(
          "Anamnesis: removed the AI tools (MCP server + skill). Reload the window to apply."
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Anamnesis: failed to remove AI tools: ${err instanceof Error ? err.message : err}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("anamnesis")) {
        projectsProvider.refresh();
        projectPromptsProvider.refresh();
        if (GraphPanel.current) {
          GraphPanel.current.refresh();
        }
        void syncAiToolsIfEnabled(context);
      }
    })
  );

  void syncAiToolsIfEnabled(context);
}

async function syncAiToolsIfEnabled(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(AI_TOOLS_DISABLED_KEY)) {
    return;
  }
  try {
    syncAiToolsSilently();
  } catch (err) {
    console.error(
      "Anamnesis: could not auto-register AI tools:",
      err instanceof Error ? err.message : err
    );
  }
}

async function runRegisterAiTools(): Promise<boolean> {
  try {
    const res = registerAiTools();
    const reload = await vscode.window.showInformationMessage(
      "Anamnesis: AI tools enabled (MCP server + skill). Reload the window so Cursor picks them up.",
      "Reload Window"
    );
    if (reload === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return res.mcpUpdated;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Anamnesis: could not enable AI tools: ${err instanceof Error ? err.message : err}`
    );
    return false;
  }
}

async function pickTag(): Promise<string | undefined> {
  const { serverUrl, clientId, secretKey } = config();
  if (!serverUrl || !clientId || !secretKey) {
    vscode.window.showWarningMessage(
      "Anamnesis: credentials are not configured. Open the Anamnesis Settings panel to set Client Id and Secret Key."
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
    if (tags.length === 0) {
      vscode.window.showWarningMessage(
        "Anamnesis: no projects found. Create a knowledge graph first."
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(tags, {
      placeHolder: "Select a project graph to open",
    });
    return picked?.label;
  } catch {
    return undefined;
  }
}

async function resolveFolderUri(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri && uri.fsPath) {
    return uri;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length === 1) {
    return folders[0].uri;
  }
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: "Select a workspace folder",
  });
  return picked?.uri;
}

function relativizeUri(uri?: vscode.Uri): string | undefined {
  if (!uri) return undefined;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) {
    return vscode.workspace.asRelativePath(uri, false);
  }
  return uri.fsPath;
}

export function deactivate(): void {
  if (GraphPanel.current) {
    GraphPanel.current.dispose();
  }
}
