import * as vscode from "vscode";

export interface GraphNode {
  id: string;
  label?: string;
  kind?: string;
  source_file?: string;
  loc?: string;
  community?: string | number | null;
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  [key: string]: unknown;
}

export interface GraphData {
  tag: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProjectMeta {
  project_name: string;
  nodes?: number;
  edges?: number;
  communities?: number;
  graph_tag?: string;
  built_at_commit?: string | null;
  shared?: boolean;
  ownerUserId?: string;
  [key: string]: unknown;
}

export interface AuthUser {
  companyId: string;
  userId: string;
  keyName: string;
  role: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface PromptRow {
  _id: string;
  title: string;
  prompt: string;
  aiCreatedPrompt: string;
  precision: number;
  status: "processing" | "ready" | "failed";
  createdAt?: string;
  updatedAt?: string;
  inQueue?: boolean;
  aiError?: string;
  [key: string]: unknown;
}

export interface GraphStats {
  tag: string;
  nodes: number;
  edges: number;
  communities: number;
  built_at_commit: string | null;
}

export interface SerializedGraphPayload {
  version?: number;
  companyId?: string;
  builtAt?: string;
  nodes: unknown[];
  edges: unknown[];
}

interface ApiEnvelope<T = unknown> {
  status?: number;
  message?: string;
  data?: T;
}

function config(): { serverUrl: string; clientId: string; secretKey: string; defaultTag: string } {
  const cfg = vscode.workspace.getConfiguration("anamnesis");
  const serverUrl = (cfg.get<string>("serverUrl") || "").replace(/\/+$/, "");
  const clientId = (cfg.get<string>("clientId") || "").trim();
  const secretKey = (cfg.get<string>("secretKey") || "").trim();
  const defaultTag = (cfg.get<string>("defaultTag") || "default").trim();
  return { serverUrl, clientId, secretKey, defaultTag };
}

function authHeaders(clientId: string, secretKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (clientId) {
    headers["X-Client-Id"] = clientId;
  }
  if (secretKey) {
    headers["X-Secret-Key"] = secretKey;
  }
  return headers;
}

function requireConfig(): { serverUrl: string; clientId: string; secretKey: string } {
  const { serverUrl, clientId, secretKey } = config();
  if (!serverUrl) {
    throw new Error("No API Base URL configured. Set it via Anamnesis Settings.");
  }
  if (!clientId || !secretKey) {
    throw new Error("Client Id and Secret Key are required. Configure them in Anamnesis Settings.");
  }
  return { serverUrl, clientId, secretKey };
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok) {
    throw new Error(body.message || res.statusText || `HTTP ${res.status}`);
  }
  if (body.data !== undefined) {
    return body.data;
  }
  return body as unknown as T;
}

async function fetchJson<T>(path: string): Promise<T> {
  const { serverUrl, clientId, secretKey } = requireConfig();
  const url = `${serverUrl}${path}`;
  const headers = authHeaders(clientId, secretKey);
  const res = await fetch(url, { headers });
  return parseEnvelope<T>(res);
}

async function fetchWithMethod<T>(
  path: string,
  method: string,
  body?: unknown
): Promise<T> {
  const { serverUrl, clientId, secretKey } = requireConfig();
  const url = `${serverUrl}${path}`;
  const headers = authHeaders(clientId, secretKey);
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parseEnvelope<T>(res);
}

export async function fetchGraph(tag?: string): Promise<GraphData> {
  const { defaultTag } = config();
  const projectName = encodeURIComponent(tag || defaultTag);
  return fetchJson<GraphData>(`/anamnesis-vscode-ext/graphs/${projectName}`);
}

export async function fetchStats(tag?: string): Promise<GraphStats> {
  const { defaultTag } = config();
  const projectName = encodeURIComponent(tag || defaultTag);
  return fetchJson<GraphStats>(
    `/anamnesis-vscode-ext/graphs/${projectName}?format=stats`
  );
}

export async function fetchProjects(): Promise<{ projects: ProjectMeta[]; count: number }> {
  return fetchJson<{ projects: ProjectMeta[]; count: number }>(
    `/anamnesis-vscode-ext/projects`
  );
}

/** Returns the authenticated user profile (Client Id + Secret Key). */
export async function fetchAuthUser(): Promise<AuthUser> {
  const { serverUrl, clientId, secretKey } = requireConfig();
  const url = `${serverUrl}/anamnesis-vscode-ext/authenticate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, secretKey }),
  });
  return parseEnvelope<AuthUser>(res);
}

export async function createRepo(projectName: string): Promise<unknown> {
  return fetchWithMethod(`/anamnesis-vscode-ext/repos`, "POST", { projectName });
}

export async function uploadGraph(
  projectName: string,
  graph: SerializedGraphPayload
): Promise<unknown> {
  return fetchWithMethod(
    `/anamnesis-vscode-ext/graphs/${encodeURIComponent(projectName)}`,
    "PUT",
    graph
  );
}

export async function deleteGraph(
  tag: string
): Promise<{ ok: boolean; tag: string; deleted: string[] }> {
  return fetchWithMethod(
    `/anamnesis-vscode-ext/graphs/${encodeURIComponent(tag)}`,
    "DELETE"
  );
}

export async function fetchPrompts(projectName: string): Promise<PromptRow[]> {
  const encoded = encodeURIComponent(projectName);
  const rows = await fetchJson<PromptRow[]>(
    `/anamnesis-vscode-ext/projects/${encoded}/prompts`
  );
  return Array.isArray(rows) ? rows : [];
}

export async function createPrompt(
  projectName: string,
  body: { title: string; prompt: string }
): Promise<PromptRow> {
  const encoded = encodeURIComponent(projectName);
  return fetchWithMethod<PromptRow>(
    `/anamnesis-vscode-ext/projects/${encoded}/prompts`,
    "POST",
    body
  );
}

export async function updatePrompt(
  projectName: string,
  promptId: string,
  body: { title: string; prompt: string; validateWithAi?: boolean }
): Promise<PromptRow> {
  const encodedProject = encodeURIComponent(projectName);
  const encodedPrompt = encodeURIComponent(promptId);
  return fetchWithMethod<PromptRow>(
    `/anamnesis-vscode-ext/projects/${encodedProject}/prompts/${encodedPrompt}`,
    "PUT",
    body
  );
}

export async function deletePromptEntry(
  projectName: string,
  promptId: string
): Promise<{ deleted: boolean }> {
  const encodedProject = encodeURIComponent(projectName);
  const encodedPrompt = encodeURIComponent(promptId);
  return fetchWithMethod<{ deleted: boolean }>(
    `/anamnesis-vscode-ext/projects/${encodedProject}/prompts/${encodedPrompt}`,
    "DELETE"
  );
}

interface ApiEnvelopeAuth {
  status?: number;
  message?: string;
  data?: AuthUser;
}

/**
 * Authenticates against st-ck-server using Client Id + Secret Key.
 */
export async function testConnection(
  serverUrl?: string,
  clientId?: string,
  secretKey?: string
): Promise<{ ok: boolean; status?: number; detail: string; latencyMs?: number }> {
  const rawUrl = (serverUrl ?? config().serverUrl).trim();
  const cid = (clientId ?? config().clientId).trim();
  const skey = (secretKey ?? config().secretKey).trim();

  if (!rawUrl) {
    return { ok: false, detail: "No API Base URL provided. Enter the server URL first." };
  }
  if (!cid) {
    return { ok: false, detail: "Client Id is required. Copy it from Anamnesis Settings → View Credentials." };
  }
  if (!skey) {
    return { ok: false, detail: "Secret Key is required. Copy it from Anamnesis Settings → View Credentials." };
  }

  const url = rawUrl.replace(/\/+$/, "");
  const started = Date.now();
  try {
    const res = await fetch(`${url}/anamnesis-vscode-ext/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: cid, secretKey: skey }),
    });
    const latencyMs = Date.now() - started;
    const body = (await res.json().catch(() => ({}))) as ApiEnvelopeAuth;

    if (res.ok && body.data) {
      const role = body.data.role ? `, role: ${body.data.role}` : "";
      const keyName = body.data.keyName ? `, key: ${body.data.keyName}` : "";
      const name = [body.data.firstName, body.data.lastName].filter(Boolean).join(" ");
      const who = name || body.data.email || body.data.userId || "";
      const whoPart = who ? ` as ${who}` : "";
      return {
        ok: true,
        status: res.status,
        latencyMs,
        detail: `Authenticated${whoPart} (${res.status}) ${latencyMs}ms${keyName}${role}`,
      };
    }

    const message = body.message || res.statusText || "Authentication failed";
    return {
      ok: false,
      status: res.status,
      latencyMs,
      detail: `HTTP ${res.status}: ${message}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not reach ${url}/anamnesis-vscode-ext/authenticate: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export { config };
