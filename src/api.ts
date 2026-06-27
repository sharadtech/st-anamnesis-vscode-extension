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
  [key: string]: unknown;
}

export interface GraphStats {
  tag: string;
  nodes: number;
  edges: number;
  communities: number;
  built_at_commit: string | null;
}

function config(): { serverUrl: string; apiKey: string; defaultTag: string } {
  const cfg = vscode.workspace.getConfiguration("anamnesis");
  const serverUrl = (cfg.get<string>("serverUrl") || "").replace(/\/+$/, "");
  const apiKey = (cfg.get<string>("apiKey") || "").trim();
  const defaultTag = (cfg.get<string>("defaultTag") || "default").trim();
  return { serverUrl, apiKey, defaultTag };
}

async function fetchJson<T>(path: string): Promise<T> {
  const { serverUrl, apiKey } = config();
  if (!serverUrl) {
    throw new Error("No Anamnesis Server URL configured. Set it via Settings → Anamnesis Server URL.");
  }
  const url = `${serverUrl}${path}`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function fetchGraph(tag?: string): Promise<GraphData> {
  const { defaultTag } = config();
  return fetchJson<GraphData>(`/graph?tag=${encodeURIComponent(tag || defaultTag)}`);
}

export async function fetchStats(tag?: string): Promise<GraphStats> {
  const { defaultTag } = config();
  return fetchJson<GraphStats>(`/graph?tag=${encodeURIComponent(tag || defaultTag)}&format=stats`);
}

export async function fetchProjects(): Promise<{ projects: ProjectMeta[]; count: number }> {
  return fetchJson<{ projects: ProjectMeta[]; count: number }>(`/graph/projects`);
}

export async function searchNodes(tag: string | undefined, query: string): Promise<{ results: GraphNode[] }> {
  const { defaultTag } = config();
  return fetchJson<{ results: GraphNode[] }>(
    `/graph?tag=${encodeURIComponent(tag || defaultTag)}&q=${encodeURIComponent(query)}`
  );
}

export async function deleteGraph(tag: string): Promise<{ ok: boolean; tag: string; deleted: string[] }> {
  const { serverUrl, apiKey } = config();
  if (!serverUrl) {
    throw new Error("No Anamnesis Server URL configured. Set it via Settings → Anamnesis Server URL.");
  }
  const url = `${serverUrl}/graph?tag=${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, { method: "DELETE", headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`DELETE ${url} -> ${res.status}: ${body?.error || res.statusText}`);
  }
  return body as { ok: boolean; tag: string; deleted: string[] };
}

/**
 * Lightweight connectivity probe used by the settings panel's "Test connection"
 * button. Uses the supplied (or configured) server URL + API key to hit the
 * /health endpoint, returning a structured result without throwing.
 */
export async function testConnection(
  serverUrl?: string,
  apiKey?: string
): Promise<{ ok: boolean; status?: number; detail: string; latencyMs?: number }> {
  const rawUrl = (serverUrl ?? config().serverUrl).trim();
  if (!rawUrl) {
    return { ok: false, detail: "No server URL provided. Enter the Anamnesis Server URL first." };
  }
  const url = rawUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  const key = (apiKey ?? "").trim();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const started = Date.now();
  try {
    const res = await fetch(`${url}/health`, { headers });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: true, status: res.status, latencyMs, detail: `OK (${res.status}) ${latencyMs}ms${text ? ` - ${text.slice(0, 120)}` : ""}` };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, latencyMs, detail: `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 160)}` : ""}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${url}/health: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export { config };
