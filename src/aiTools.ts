import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { config } from "./api";
import { startCredentialsMcpServer } from "./credentialsMcpServer";

export const AI_TOOLS_DISABLED_KEY = "anamnesis.aiToolsDisabled";

const MCP_SERVER_KEY = "anamnesis";
const CREDENTIALS_SERVER_KEY = "anamnesis-credentials";
const SKILL_NAME = "anamnesis";

export type IdeKind = "cursor" | "vscode";

export interface IdeTarget {
  kind: IdeKind;
  label: string;
  mcpPath: string;
  skillPath: string;
}

export function detectIde(): IdeTarget {
  const appName = String(vscode.env.appName || "");
  const scheme = String(vscode.env.uriScheme || "").toLowerCase();
  const isCursor =
    scheme === "cursor" ||
    /cursor/i.test(appName);

  if (isCursor) {
    const home = path.join(os.homedir(), ".cursor");
    return {
      kind: "cursor",
      label: "Cursor",
      mcpPath: path.join(home, "mcp.json"),
      skillPath: path.join(home, "skills", SKILL_NAME, "SKILL.md"),
    };
  }

  return {
    kind: "vscode",
    label: vscodeProductLabel(),
    mcpPath: path.join(vscodeUserDir(), "mcp.json"),
    skillPath: path.join(os.homedir(), ".copilot", "skills", SKILL_NAME, "SKILL.md"),
  };
}

function vscodeProductLabel(): string {
  const name = String(vscode.env.appName || "Visual Studio Code");
  if (/insiders/i.test(name)) {
    return "Visual Studio Code Insiders";
  }
  if (/codium/i.test(name)) {
    return "VSCodium";
  }
  return "Visual Studio Code";
}

/** User profile folder that holds settings.json / mcp.json for this VS Code build. */
function vscodeUserDir(): string {
  const appName = String(vscode.env.appName || "");
  let folder = "Code";
  if (/insiders/i.test(appName)) {
    folder = "Code - Insiders";
  } else if (/codium/i.test(appName)) {
    folder = "VSCodium";
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", folder, "User");
  }
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, folder, "User");
  }
  return path.join(os.homedir(), ".config", folder, "User");
}

function readJsonSafe(file: string): Record<string, any> {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function skillContent(serverUrl: string): string {
  return `---
name: anamnesis
description: Use the Anamnesis knowledge graph (via the "anamnesis" MCP server) to answer architecture, dependency, and impact questions about the current codebase before reading files with grep/search. The graph captures files, classes, functions, methods and their contains/imports/calls relationships.
---

# Anamnesis knowledge graph

This workspace has Anamnesis knowledge graphs available through the **anamnesis** MCP
server (backed by ${serverUrl}). Each graph is a project you created via
"Anamnesis: Create Knowledge Graph". Nodes are files/classes/functions/methods; edges
are \`contains\`, \`imports\`, and \`calls\`.

## MANDATORY: consult the graph before exploring code

Before using grep/file search to answer an architecture, dependency, or impact
question, query the graph first with the MCP tools. A scoped subgraph is far cheaper
than reading many files and surfaces cross-file relationships text search cannot find.

Typical flow:
1. \`list_projects\` - find the project name (graph tag) for the codebase.
2. \`graph_stats(project)\` - orient: size, communities, node kinds.
3. \`query_graph(project, question)\` - scoped subgraph for any "how/where/what" question.

## Project name resolution

When you query a project by name, the server resolves it **own-first**: if the
logged-in user has their own knowledge graph for that name, that graph is used.
Only when they do not have their own graph does the server fall back to a
**company-shared** graph owned by another user (read-only). Two users can each
own a graph with the same project name without clashing.

## Tools

- \`list_projects\` - all graphs available to you, with node/edge counts.
- \`graph_stats(project)\` - totals and node counts by kind.
- \`search_symbols(project, query)\` - find nodes by name / id / source file.
- \`get_node(project, symbol)\` - a symbol with its callers, callees, imports.
- \`get_neighbors(project, symbol, direction)\` - direct neighbors (in|out|both).
- \`shortest_path(project, from, to)\` - dependency path between two symbols.
- \`impact_of_change(project, symbol)\` - everything that depends on a symbol. Run this
  BEFORE editing a symbol to understand the blast radius.
- \`god_nodes(project)\` - most connected nodes (architectural hubs / hotspots).
- \`query_graph(project, question)\` - keyword-driven scoped subgraph.

## Stored credentials (local MCP)

When the Anamnesis extension is running, a second MCP server **anamnesis-credentials**
is available on localhost. Ciphertext is stored on the Anamnesis server; decryption
happens only inside the extension.

- \`list_credential_sets\` - names and metadata of saved credential sets (no secret values).
- \`get_credentials(name)\` - decrypt a named set locally and return key/value pairs.

Use \`get_credentials\` only when the user refers to a stored credential set
(for example "use my Production database credentials"). A set may be tagged
with multiple Anamnesis projects; prefer a set whose \`projectTags\` include
the current project when more than one match exists.

## When to fall back to grep/Read

Only after the graph has oriented you and you need the exact source lines to modify,
or when the symbol is not yet in the graph (regenerate it with
"Anamnesis: Create Knowledge Graph"), or the MCP server is unreachable.
`;
}

function cursorMcpEntry(
  serverUrl: string,
  clientId: string,
  secretKey: string,
  credentialsUrl: string,
  token: string
): Record<string, unknown> {
  return {
    [MCP_SERVER_KEY]: {
      url: `${serverUrl}/anamnesis-vscode-ext/mcp`,
      transport: "streamable-http",
      headers: {
        "X-Client-Id": clientId,
        "X-Secret-Key": secretKey,
      },
    },
    [CREDENTIALS_SERVER_KEY]: {
      url: credentialsUrl,
      transport: "streamable-http",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  };
}

function vscodeMcpEntry(
  serverUrl: string,
  clientId: string,
  secretKey: string,
  credentialsUrl: string,
  token: string
): Record<string, unknown> {
  return {
    [MCP_SERVER_KEY]: {
      type: "http",
      url: `${serverUrl}/anamnesis-vscode-ext/mcp`,
      headers: {
        "X-Client-Id": clientId,
        "X-Secret-Key": secretKey,
      },
    },
    [CREDENTIALS_SERVER_KEY]: {
      type: "http",
      url: credentialsUrl,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  };
}

function writeCursorMcp(
  mcpPath: string,
  entries: Record<string, unknown>
): void {
  const mcp = readJsonSafe(mcpPath);
  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") {
    mcp.mcpServers = {};
  }
  Object.assign(mcp.mcpServers, entries);
  writeJson(mcpPath, mcp);
}

function writeVsCodeMcp(
  mcpPath: string,
  entries: Record<string, unknown>
): void {
  const mcp = readJsonSafe(mcpPath);
  if (!mcp.servers || typeof mcp.servers !== "object") {
    mcp.servers = {};
  }
  Object.assign(mcp.servers, entries);
  writeJson(mcpPath, mcp);
}

function removeMcpKeys(mcpPath: string, rootKey: "mcpServers" | "servers"): boolean {
  if (!fs.existsSync(mcpPath)) {
    return false;
  }
  const mcp = readJsonSafe(mcpPath);
  const bucket = mcp[rootKey];
  if (!bucket || typeof bucket !== "object") {
    return false;
  }
  const had =
    Object.prototype.hasOwnProperty.call(bucket, MCP_SERVER_KEY) ||
    Object.prototype.hasOwnProperty.call(bucket, CREDENTIALS_SERVER_KEY);
  if (!had) {
    return false;
  }
  delete bucket[MCP_SERVER_KEY];
  delete bucket[CREDENTIALS_SERVER_KEY];
  writeJson(mcpPath, mcp);
  return true;
}

export interface RegisterResult {
  mcpUpdated: boolean;
  skillWritten: boolean;
  mcpPath: string;
  skillPath: string;
  ide: IdeKind;
  ideLabel: string;
}

export async function registerAiTools(): Promise<RegisterResult> {
  const { serverUrl, clientId, secretKey } = config();
  if (!serverUrl) {
    throw new Error("Set the API Base URL in Anamnesis Settings before installing MCP and Skill.");
  }
  if (!clientId || !secretKey) {
    throw new Error("Set the Client Id and Secret Key in Anamnesis Settings before installing MCP and Skill.");
  }

  const ide = detectIde();
  const credentialsMcp = await startCredentialsMcpServer();

  if (ide.kind === "cursor") {
    writeCursorMcp(
      ide.mcpPath,
      cursorMcpEntry(serverUrl, clientId, secretKey, credentialsMcp.url, credentialsMcp.token)
    );
  } else {
    writeVsCodeMcp(
      ide.mcpPath,
      vscodeMcpEntry(serverUrl, clientId, secretKey, credentialsMcp.url, credentialsMcp.token)
    );
  }

  fs.mkdirSync(path.dirname(ide.skillPath), { recursive: true });
  fs.writeFileSync(ide.skillPath, skillContent(serverUrl), "utf-8");

  return {
    mcpUpdated: true,
    skillWritten: true,
    mcpPath: ide.mcpPath,
    skillPath: ide.skillPath,
    ide: ide.kind,
    ideLabel: ide.label,
  };
}

export interface UnregisterResult {
  mcpRemoved: boolean;
  skillRemoved: boolean;
  ideLabel: string;
}

export function unregisterAiTools(): UnregisterResult {
  const ide = detectIde();
  const rootKey = ide.kind === "cursor" ? "mcpServers" : "servers";
  const mcpRemoved = removeMcpKeys(ide.mcpPath, rootKey);

  let skillRemoved = false;
  const skillDir = path.dirname(ide.skillPath);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    skillRemoved = true;
  }

  return { mcpRemoved, skillRemoved, ideLabel: ide.label };
}

export function isRegistered(): boolean {
  const ide = detectIde();
  const mcp = readJsonSafe(ide.mcpPath);
  if (ide.kind === "cursor") {
    return !!(mcp.mcpServers && mcp.mcpServers[MCP_SERVER_KEY]);
  }
  return !!(mcp.servers && mcp.servers[MCP_SERVER_KEY]);
}

export function canRegisterAiTools(): boolean {
  const { serverUrl, clientId, secretKey } = config();
  return !!(serverUrl && clientId && secretKey);
}

/** Register MCP + skill when credentials are configured. No-op if credentials are missing. */
export async function syncAiToolsSilently(): Promise<boolean> {
  if (!canRegisterAiTools()) {
    return false;
  }
  await registerAiTools();
  return true;
}
