import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { config } from "./api";
import { startCredentialsMcpServer } from "./credentialsMcpServer";

const MCP_SERVER_KEY = "anamnesis";
const CREDENTIALS_SERVER_KEY = "anamnesis-credentials";
const SKILL_NAME = "anamnesis";

function cursorHome(): string {
  return path.join(os.homedir(), ".cursor");
}

function mcpJsonPath(): string {
  return path.join(cursorHome(), "mcp.json");
}

function skillDir(): string {
  return path.join(cursorHome(), "skills", SKILL_NAME);
}

function skillPath(): string {
  return path.join(skillDir(), "SKILL.md");
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

export interface RegisterResult {
  mcpUpdated: boolean;
  skillWritten: boolean;
  mcpPath: string;
  skillPath: string;
}

export async function registerAiTools(): Promise<RegisterResult> {
  const { serverUrl, clientId, secretKey } = config();
  if (!serverUrl) {
    throw new Error("Set the API Base URL in Anamnesis Settings before registering AI tools.");
  }
  if (!clientId || !secretKey) {
    throw new Error("Set the Client Id and Secret Key in Anamnesis Settings before registering AI tools.");
  }

  const credentialsMcp = await startCredentialsMcpServer();

  fs.mkdirSync(cursorHome(), { recursive: true });

  // --- Merge ~/.cursor/mcp.json (never clobber other servers) ---
  const mcp = readJsonSafe(mcpJsonPath());
  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") {
    mcp.mcpServers = {};
  }
  mcp.mcpServers[MCP_SERVER_KEY] = {
    url: `${serverUrl}/anamnesis-vscode-ext/mcp`,
    transport: "streamable-http",
    headers: {
      "X-Client-Id": clientId,
      "X-Secret-Key": secretKey,
    },
  };
  mcp.mcpServers[CREDENTIALS_SERVER_KEY] = {
    url: credentialsMcp.url,
    transport: "streamable-http",
    headers: {
      Authorization: `Bearer ${credentialsMcp.token}`,
    },
  };
  fs.writeFileSync(mcpJsonPath(), JSON.stringify(mcp, null, 2) + "\n", "utf-8");

  // --- Write the skill ---
  fs.mkdirSync(skillDir(), { recursive: true });
  fs.writeFileSync(skillPath(), skillContent(serverUrl), "utf-8");

  return {
    mcpUpdated: true,
    skillWritten: true,
    mcpPath: mcpJsonPath(),
    skillPath: skillPath(),
  };
}

export interface UnregisterResult {
  mcpRemoved: boolean;
  skillRemoved: boolean;
}

export function unregisterAiTools(): UnregisterResult {
  let mcpRemoved = false;
  let skillRemoved = false;

  if (fs.existsSync(mcpJsonPath())) {
    const mcp = readJsonSafe(mcpJsonPath());
    if (mcp.mcpServers && (mcp.mcpServers[MCP_SERVER_KEY] || mcp.mcpServers[CREDENTIALS_SERVER_KEY])) {
      delete mcp.mcpServers[MCP_SERVER_KEY];
      delete mcp.mcpServers[CREDENTIALS_SERVER_KEY];
      fs.writeFileSync(mcpJsonPath(), JSON.stringify(mcp, null, 2) + "\n", "utf-8");
      mcpRemoved = true;
    }
  }

  if (fs.existsSync(skillDir())) {
    fs.rmSync(skillDir(), { recursive: true, force: true });
    skillRemoved = true;
  }

  return { mcpRemoved, skillRemoved };
}

export function isRegistered(): boolean {
  const mcp = readJsonSafe(mcpJsonPath());
  return !!(mcp.mcpServers && mcp.mcpServers[MCP_SERVER_KEY]);
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
