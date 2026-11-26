import * as path from "path";
import * as vscode from "vscode";
import { GraphPanel } from "./graphPanel";
import { SettingsPanel } from "./settingsPanel";
import { PromptsPanel } from "./promptsPanel";
import { CredentialsPanel } from "./credentialsPanel";
import { CredentialsViewPanel } from "./credentialsViewPanel";
import { AiContextPanel } from "./aiContextPanel";
import {
  fetchProjects,
  deleteGraph,
  fetchCredentialSets,
  deleteCredentialSet,
  setCredentialSetLocked,
  fetchAiContexts,
  deleteAiContext,
  AuthUser,
  CredentialSetRow,
  AiContextRow,
  config,
  projectTagsOf,
  isLocalId,
} from "./api";
import {
  describeReason,
  getModeState,
  initModeMonitor,
  modeReady,
  ModeState,
  onDidChangeMode,
  probe,
} from "./mode";
import { counts as localCounts, isEmpty as localStoreEmpty, localRoot } from "./localStore";
import { ConflictKind, syncLocalToCloud } from "./sync";
import { generateAndUpload } from "./generate";
import {
  registerAiTools,
  unregisterAiTools,
  syncAiToolsSilently,
  AI_TOOLS_DISABLED_KEY,
} from "./aiTools";
import {
  startCredentialsMcpServer,
  stopCredentialsMcpServer,
} from "./credentialsMcpServer";


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

/** First row of every view while in local mode. */
function localModeItem(state: ModeState): MessageTreeItem {
  const item = new MessageTreeItem("local-mode", "Local mode", describeReason(state.reason), "device-desktop");
  item.tooltip =
    `${describeReason(state.reason)}.\n` +
    `Data is stored on this machine in ${localRoot()} and uploads automatically ` +
    `when Anamnesis Cloud is reachable.\n${state.detail}\n\nClick to check the connection now.`;
  item.command = { command: "anamnesis.checkConnection", title: "Check Connection" };
  return item;
}

/** Header rows for a view: the local-mode notice or the signed-in user. */
async function headerItems(withUser: boolean): Promise<Array<MessageTreeItem | UserHeaderTreeItem>> {
  const state = await modeReady();
  if (state.mode === "local") {
    return [localModeItem(state)];
  }
  return withUser && state.user ? [new UserHeaderTreeItem(state.user)] : [];
}

const localSuffix = (id: string | undefined) => (isLocalId(id) ? " · local (not uploaded yet)" : "");

class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: string,
    public readonly shared: boolean,
    label: string,
    detail: string,
    public readonly local = false
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = shared ? "sharedProject" : "ownedProject";
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon(shared ? "cloud-download" : local ? "device-desktop" : "repo");
    this.tooltip =
      `Project: ${label}\nTag: ${tag}\n${detail}${shared ? "\nShared (read-only)" : ""}` +
      (local ? `\nStored on this machine (${localRoot()})` : "");
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
type CredentialsTreeItem = MessageTreeItem | CredentialSetTreeItem;
type AiContextTreeItem = MessageTreeItem | AiContextRecordTreeItem;

class AiContextRecordTreeItem extends vscode.TreeItem {
  constructor(
    public readonly recordId: string,
    public readonly projectName: string,
    preview: string
  ) {
    super(projectName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "aiContext";
    this.description = preview;
    this.iconPath = new vscode.ThemeIcon("note");
    this.tooltip = `AI Context: ${projectName}\nClick to view`;
    this.command = {
      command: "anamnesis.openAiContext",
      title: "View AI Context",
      arguments: [recordId],
    };
  }
}

class CredentialSetTreeItem extends vscode.TreeItem {
  constructor(
    public readonly credentialId: string,
    public readonly setName: string,
    detail: string,
    public readonly locked: boolean
  ) {
    super(setName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = locked ? "credentialSetLocked" : "credentialSet";
    this.description = locked ? `${detail} · locked` : detail;
    this.iconPath = new vscode.ThemeIcon(locked ? "lock" : "key");
    this.tooltip = locked
      ? `Credential set: ${setName}\n${detail}\nLocked. Click to view.`
      : `Credential set: ${setName}\n${detail}\nClick to edit`;
    this.command = {
      command: "anamnesis.openCredentialSet",
      title: locked ? "View Credential Set" : "Open Credential Set",
      arguments: [credentialId, locked],
    };
  }
}

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
    const items: AnamnesisTreeItem[] = await headerItems(true);
    const headerCount = items.length;

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
        const isLocal = p.local === true;
        const stats = `${nodes}n / ${edges}e / ${commit}`;
        const detail = shared ? `${stats} · shared` : isLocal ? `${stats} · local` : stats;
        items.push(new ProjectTreeItem(tag, shared, tag, detail, isLocal));
      }
      if (items.length === headerCount) {
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
    const header = await headerItems(false);

    try {
      const { projects } = await fetchProjects();
      const seen = new Set<string>();
      const items: ProjectPromptsTreeItem[] = [];
      for (const p of projects) {
        const tag = (p.graph_tag as string) || (p.project_name as string);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        const shared = p.shared === true;
        const detail = shared ? "shared project" : p.local === true ? "view prompts · local" : "view prompts";
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
      return [...(header as ProjectPromptsTreeItem[]), ...items];
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
let credentialsProvider: CredentialsProvider;
let aiContextProvider: AiContextProvider;

class AiContextProvider implements vscode.TreeDataProvider<AiContextTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: AiContextTreeItem): AiContextTreeItem {
    return element;
  }

  async getChildren(element?: AiContextTreeItem): Promise<AiContextTreeItem[]> {
    if (element) {
      return [];
    }
    const header = (await headerItems(false)) as AiContextTreeItem[];
    try {
      const rows = await fetchAiContexts();
      if (!rows.length) {
        return [
          ...header,
          new MessageTreeItem(
            "none",
            "No AI Context yet",
            "Click + to add project context",
            "info"
          ),
        ];
      }
      return [
        ...header,
        ...rows.map((row: AiContextRow) => {
          const text = String(row.context || "").replace(/\s+/g, " ").trim();
          const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
          return new AiContextRecordTreeItem(String(row._id || ""), row.projectName, preview + localSuffix(row._id));
        }),
      ];
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: could not load AI Context: ${err instanceof Error ? err.message : err}`
      );
      return [
        new MessageTreeItem(
          "load-failed",
          "Could not load AI Context",
          err instanceof Error ? err.message : String(err),
          "error"
        ),
      ];
    }
  }
}

class CredentialsProvider implements vscode.TreeDataProvider<CredentialsTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: CredentialsTreeItem): CredentialsTreeItem {
    return element;
  }

  async getChildren(element?: CredentialsTreeItem): Promise<CredentialsTreeItem[]> {
    if (element) {
      return [];
    }
    const header = (await headerItems(false)) as CredentialsTreeItem[];

    try {
      const rows = await fetchCredentialSets();
      if (!rows.length) {
        return [
          ...header,
          new MessageTreeItem(
            "none",
            "No credentials yet",
            "Click + to add a credential set",
            "info"
          ),
        ];
      }
      return [
        ...header,
        ...rows.map((row: CredentialSetRow) => {
          const id = String(row._id ?? "");
          const count = Number(row.keyCount ?? 0);
          const tags = projectTagsOf(row);
          const tag = tags.length ? ` · ${tags.join(", ")}` : "";
          const detail = `${count} key${count === 1 ? "" : "s"}${tag}${localSuffix(id)}`;
          return new CredentialSetTreeItem(id, row.name, detail, row.locked === true);
        }),
      ];
    } catch (err) {
      vscode.window.showWarningMessage(
        `Anamnesis: could not load credentials: ${err instanceof Error ? err.message : err}`
      );
      return [
        new MessageTreeItem(
          "load-failed",
          "Could not load credentials",
          err instanceof Error ? err.message : String(err),
          "error"
        ),
      ];
    }
  }
}

async function setCredentialLock(
  item: CredentialSetTreeItem | undefined,
  locked: boolean
): Promise<void> {
  if (!(item instanceof CredentialSetTreeItem)) {
    vscode.window.showWarningMessage("Anamnesis: no credential set selected.");
    return;
  }
  try {
    await setCredentialSetLocked(item.credentialId, locked);
    credentialsProvider.refresh();
    CredentialsPanel.current?.syncLock(item.credentialId, locked);
    CredentialsViewPanel.current?.syncLock(item.credentialId, locked);
    vscode.window.showInformationMessage(
      locked
        ? `Anamnesis: locked credentials "${item.setName}".`
        : `Anamnesis: unlocked credentials "${item.setName}".`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Anamnesis: could not update lock: ${err instanceof Error ? err.message : err}`
    );
  }
}

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

  credentialsProvider = new CredentialsProvider();
  const credentialsTreeView = vscode.window.createTreeView("anamnesis.aiCredentials", {
    treeDataProvider: credentialsProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(credentialsTreeView);

  aiContextProvider = new AiContextProvider();
  const aiContextTreeView = vscode.window.createTreeView("anamnesis.aiContext", {
    treeDataProvider: aiContextProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(aiContextTreeView);

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
    vscode.commands.registerCommand("anamnesis.addCredentials", async () => {
      await CredentialsPanel.createOrShow(context.extensionUri, undefined, () => {
        credentialsProvider.refresh();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.refreshCredentials", () => {
      credentialsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.addAiContext", async () => {
      await AiContextPanel.createOrShow(context.extensionUri, undefined, "edit", () => {
        aiContextProvider.refresh();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.refreshAiContext", () => {
      aiContextProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openAiContext", async (id?: string) => {
      if (!id) {
        vscode.window.showWarningMessage("Anamnesis: no AI Context record selected.");
        return;
      }
      await AiContextPanel.createOrShow(context.extensionUri, id, "view");
    })

  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.copyAiContextName",
      async (item?: AiContextRecordTreeItem) => {
        const name = item instanceof AiContextRecordTreeItem ? item.projectName.trim() : "";
        if (!name) {
          vscode.window.showWarningMessage("Anamnesis: no AI Context name to copy.");
          return;
        }
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Anamnesis: copied AI Context name "${name}".`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.editAiContext",
      async (item?: AiContextRecordTreeItem | string) => {
        const id = typeof item === "string" ? item : item?.recordId;
        if (!id) {
          vscode.window.showWarningMessage("Anamnesis: no AI Context record selected.");
          return;
        }
        await AiContextPanel.createOrShow(context.extensionUri, id, "edit", () => {
          aiContextProvider.refresh();
        });
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.deleteAiContext",
      async (item?: AiContextRecordTreeItem) => {
        const id = item instanceof AiContextRecordTreeItem ? item.recordId : "";
        const name = item instanceof AiContextRecordTreeItem ? item.projectName : "this record";
        if (!id) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete AI Context for "${name}"?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          await deleteAiContext(id);
          vscode.window.showInformationMessage(`Anamnesis: deleted AI Context "${name}".`);
          aiContextProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Anamnesis: delete failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.openCredentialSet", async (id?: string, locked?: boolean) => {
      if (!id) {
        vscode.window.showWarningMessage("Anamnesis: no credential set selected.");
        return;
      }
      const onSaved = () => {
        credentialsProvider.refresh();
      };
      if (locked === true) {
        CredentialsPanel.closeIf(id);
        await CredentialsViewPanel.createOrShow(context.extensionUri, id);
        return;
      }
      await CredentialsPanel.createOrShow(context.extensionUri, id, onSaved);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.copyCredentialSetName",
      async (item?: CredentialSetTreeItem) => {
        const name = item instanceof CredentialSetTreeItem ? item.setName.trim() : "";
        if (!name) {
          vscode.window.showWarningMessage("Anamnesis: no credential name to copy.");
          return;
        }
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Anamnesis: copied credential name "${name}".`);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.lockCredentialSet",
      async (item?: CredentialSetTreeItem) => {
        await setCredentialLock(item, true);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.unlockCredentialSet",
      async (item?: CredentialSetTreeItem) => {
        await setCredentialLock(item, false);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anamnesis.deleteCredentialSet",
      async (item?: CredentialSetTreeItem | string) => {
        const id = typeof item === "string" ? item : item?.credentialId;
        const name = item instanceof CredentialSetTreeItem ? item.setName : "this credential set";
        if (!id) {
          return;
        }
        if (item instanceof CredentialSetTreeItem && item.locked) {
          vscode.window.showWarningMessage(
            "Anamnesis: unlock this credential set before deleting it."
          );
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete credential set "${name}"?\nThis cannot be undone.`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          await deleteCredentialSet(id);
          vscode.window.showInformationMessage(`Anamnesis: deleted credentials "${name}".`);
          CredentialsViewPanel.closeIf(id);
          credentialsProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Anamnesis: delete failed: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    )
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
      SettingsPanel.createOrShow(context.extensionUri, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.createGraph", async (uri?: vscode.Uri) => {
      const folderUri = await resolveFolderUri(uri);
      if (!folderUri) {
        return;
      }
      try {
        const { projectName, savedTo } = await generateAndUpload(folderUri, context.extensionPath);
        refreshAllViews();
        const where =
          savedTo === "local"
            ? " and saved on this machine (local mode). It uploads automatically when Anamnesis Cloud is reachable"
            : "";
        const view = await vscode.window.showInformationMessage(
          `Anamnesis: knowledge graph created for "${projectName}"${where}.`,
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
        const isLocal = item instanceof ProjectTreeItem && item.local;
        const confirm = await vscode.window.showWarningMessage(
          isLocal
            ? `Delete the local knowledge graph for "${tag}"?\nIt is stored on this machine and has not been uploaded. This cannot be undone.`
            : `Delete the knowledge graph for "${tag}" from Anamnesis Cloud?\nThis removes the graph from Redis and the repository record. This cannot be undone.`,
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
          `Anamnesis: removed the AI tools (MCP + skill) from ${res.ideLabel}. Reload the window to apply.`
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
        credentialsProvider.refresh();
        aiContextProvider.refresh();
        if (GraphPanel.current) {
          GraphPanel.current.refresh();
        }
        void syncAiToolsIfEnabled(context);
      }
    })
  );

  // Status bar shows Cloud / Local / Syncing; click to re-check the connection.
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "anamnesis.checkConnection";
  context.subscriptions.push(statusItem);
  updateStatus();
  statusItem.show();
  // Keep the pending-item count fresh after local saves made from panels.
  const statusTimer = setInterval(updateStatus, 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("anamnesis.checkConnection", async () => {
      statusItem.text = "$(sync~spin) Anamnesis";
      const state = await probe();
      updateStatus();
      if (state.mode === "cloud") {
        const ran = await runSync(true);
        if (!ran) {
          vscode.window.showInformationMessage(`Anamnesis: connected to Anamnesis Cloud. ${state.detail}`);
        }
      } else {
        vscode.window.showWarningMessage(
          `Anamnesis: local mode. ${describeReason(state.reason)}. ${state.detail}`
        );
      }
    }),
    vscode.commands.registerCommand("anamnesis.syncLocalData", async () => {
      const state = await probe();
      if (state.mode !== "cloud") {
        vscode.window.showWarningMessage(
          `Anamnesis: cannot sync. ${describeReason(state.reason)}. Local data stays on this machine.`
        );
        return;
      }
      const ran = await runSync(true);
      if (!ran) {
        vscode.window.showInformationMessage("Anamnesis: nothing to sync. The local store is empty.");
      }
    }),
    onDidChangeMode((state) => {
      updateStatus();
      refreshAllViews();
      if (state.mode === "cloud") {
        void runSync(false);
      } else if (state.reason === "unreachable") {
        vscode.window.showWarningMessage(
          "Anamnesis: Anamnesis Cloud is unreachable. Switched to local mode: changes are saved on this machine and upload automatically when the connection returns."
        );
      }
    })
  );

  // The local MCP gateway serves agents in both modes, so start it regardless
  // of credentials, then refresh every MCP config (VS Code, Cursor, Claude Code).
  void initModeMonitor(context).then((state) => {
    updateStatus();
    refreshAllViews();
    if (state.mode === "cloud") {
      void runSync(false);
    }
  });
  void startCredentialsMcpServer()
    .then(() => syncAiToolsIfEnabled(context))
    .catch((err) => {
      console.error(
        "Anamnesis: could not start local MCP gateway:",
        err instanceof Error ? err.message : err
      );
    });
}

let statusItem: vscode.StatusBarItem;
let syncing = false;

function refreshAllViews(): void {
  projectsProvider?.refresh();
  projectPromptsProvider?.refresh();
  credentialsProvider?.refresh();
  aiContextProvider?.refresh();
  GraphPanel.current?.refresh();
}

function updateStatus(): void {
  if (!statusItem) return;
  const state = getModeState();
  if (syncing) {
    statusItem.text = "$(sync~spin) Anamnesis: Syncing";
    statusItem.tooltip = "Uploading local data to Anamnesis Cloud…";
    return;
  }
  if (state.mode === "cloud") {
    statusItem.text = "$(cloud) Anamnesis";
    statusItem.tooltip = `Anamnesis: Cloud mode\n${state.detail}\nClick to re-check.`;
    statusItem.backgroundColor = undefined;
  } else {
    const c = localCounts();
    const pending = c.graphs + c.prompts + c.aiContexts + c.credentials;
    statusItem.text = `$(device-desktop) Anamnesis: Local${pending ? ` (${pending})` : ""}`;
    statusItem.tooltip =
      `Anamnesis: Local mode. ${describeReason(state.reason)}.\n${state.detail}\n` +
      `Stored in ${localRoot()}: ${c.graphs} graph(s), ${c.prompts} prompt(s), ` +
      `${c.aiContexts} AI Context, ${c.credentials} credential set(s).\nClick to re-check the connection.`;
    statusItem.backgroundColor =
      state.reason === "auth-failed" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }
}

const CONFLICT_LABEL: Record<ConflictKind, string> = {
  graph: "Knowledge graph",
  aiContext: "AI Context",
  credentials: "Credential set",
};

/**
 * Upload the local store to the cloud. Returns false when there was nothing
 * to do. `manual` shows a message even when another window is syncing.
 */
async function runSync(manual: boolean): Promise<boolean> {
  if (syncing || localStoreEmpty()) {
    return false;
  }
  syncing = true;
  updateStatus();
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Anamnesis: uploading local data", cancellable: false },
      (progress) =>
        syncLocalToCloud({
          progress: (message) => progress.report({ message }),
          askConflict: async (kind, name, renamedTo) => {
            const pick = await vscode.window.showQuickPick(
              [
                { label: "Overwrite cloud", description: "Replace the cloud copy with the local one", choice: "overwrite" as const },
                { label: "Keep both", description: `Upload the local copy as "${renamedTo}"`, choice: "rename" as const },
                { label: "Skip", description: "Keep it on this machine for now (asked again next sync)", choice: "skip" as const },
              ],
              {
                title: `${CONFLICT_LABEL[kind]} "${name}" already exists in Anamnesis Cloud`,
                placeHolder: "Choose how to upload the local copy",
                ignoreFocusOut: true,
              }
            );
            return pick?.choice ?? "skip";
          },
        })
    );
    if (!result) {
      if (manual) {
        vscode.window.showInformationMessage("Anamnesis: another window is already uploading local data.");
      }
      return true;
    }
    const parts = [`uploaded ${result.uploaded}`];
    if (result.skipped) parts.push(`skipped ${result.skipped} (kept on this machine)`);
    if (result.failed) parts.push(`failed ${result.failed}`);
    const summary = `Anamnesis: local data sync ${result.aborted ? "stopped" : "finished"}: ${parts.join(", ")}.`;
    if (result.failed || result.aborted) {
      vscode.window.showWarningMessage(`${summary}\n${result.errors.slice(0, 5).join("\n")}`);
    } else if (result.uploaded || result.skipped) {
      vscode.window.showInformationMessage(summary);
    }
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Anamnesis: local data sync failed: ${err instanceof Error ? err.message : err}`
    );
    return true;
  } finally {
    syncing = false;
    updateStatus();
    refreshAllViews();
  }
}

async function syncAiToolsIfEnabled(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(AI_TOOLS_DISABLED_KEY)) {
    return;
  }
  try {
    await syncAiToolsSilently();
  } catch (err) {
    console.error(
      "Anamnesis: could not auto-register AI tools:",
      err instanceof Error ? err.message : err
    );
  }
}

async function runRegisterAiTools(): Promise<boolean> {
  try {
    const res = await registerAiTools();
    if (res.claudeCodeError) {
      vscode.window.showWarningMessage(`Anamnesis: Claude Code MCP config not updated: ${res.claudeCodeError}`);
    }
    const targets = [res.ideLabel, ...res.otherIdes, ...(res.claudeCode ? ["Claude Code"] : [])].join(", ");
    const reload = await vscode.window.showInformationMessage(
      `Anamnesis: MCP and skill installed for ${targets}. Reload the window so the IDE picks them up (in Claude Code, run /mcp to reconnect).`,
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
  void stopCredentialsMcpServer();
}
