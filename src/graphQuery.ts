/**
 * Local implementations of the "anamnesis" MCP graph tools, answered from the
 * graphs in the local store. Used by the local MCP gateway in local mode.
 * Tool names and arguments match the cloud server (see the skill text in
 * aiTools.ts).
 */
import * as local from "./localStore";

interface QNode {
  id: string;
  label: string;
  kind: string;
  file?: string;
  line?: number;
  community?: number | string;
}

interface QEdge {
  source: string;
  target: string;
  relation: string;
}

interface LoadedGraph {
  mtime: number;
  nodes: Map<string, QNode>;
  out: Map<string, QEdge[]>;
  in: Map<string, QEdge[]>;
  edgeCount: number;
}

/** Relations that describe structure rather than a dependency. */
const STRUCTURAL = new Set(["contains", "defines", "has_module", "child_of", "attribute_of", "member_of", "documents"]);

const cache = new Map<string, LoadedGraph>();
const CACHE_MAX = 8;

function load(project: string): LoadedGraph {
  if (!project) {
    throw new Error("`project` is required. Call list_projects to see the available projects.");
  }
  const mtime = local.graphFileMtime(project);
  const hit = cache.get(project);
  if (hit && hit.mtime === mtime) {
    return hit;
  }
  const raw = local.readSerializedGraph(project);
  if (!raw) {
    const known = local.listGraphNames();
    throw new Error(
      `No local knowledge graph named "${project}".` +
        (known.length ? ` Available: ${known.join(", ")}` : " Create one with \"Anamnesis: Create Knowledge Graph\".")
    );
  }
  const g: LoadedGraph = { mtime, nodes: new Map(), out: new Map(), in: new Map(), edgeCount: 0 };
  for (const n of raw.nodes as Array<Record<string, unknown>>) {
    const loc = n.sourceLocation as { line?: number } | undefined;
    g.nodes.set(String(n.id), {
      id: String(n.id),
      label: String(n.label ?? n.id),
      kind: String(n.kind ?? ""),
      file: (n.sourceFile as string) ?? (n.source_file as string),
      line: loc?.line,
      community: n.community as number | undefined,
    });
  }
  for (const e of raw.edges as Array<Record<string, unknown>>) {
    const edge: QEdge = { source: String(e.source), target: String(e.target), relation: String(e.relation ?? "") };
    if (!g.nodes.has(edge.source) || !g.nodes.has(edge.target)) continue;
    push(g.out, edge.source, edge);
    push(g.in, edge.target, edge);
    g.edgeCount++;
  }
  cache.set(project, g);
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value as string);
  }
  return g;
}

function push(map: Map<string, QEdge[]>, key: string, edge: QEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const num = (v: unknown, dflt: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
};

function scoreNode(n: QNode, q: string): number {
  const label = n.label.toLowerCase();
  if (label === q || n.id.toLowerCase() === q) return 100;
  let s = 0;
  if (label.startsWith(q)) s = Math.max(s, 60);
  if (label.includes(q)) s = Math.max(s, 40);
  if (n.id.toLowerCase().includes(q)) s = Math.max(s, 20);
  if ((n.file || "").toLowerCase().includes(q)) s = Math.max(s, 10);
  return s;
}

/** Resolve a symbol by id, exact label, or best partial match. */
function resolve(g: LoadedGraph, symbol: string): QNode {
  if (!symbol) {
    throw new Error("`symbol` is required.");
  }
  const exact = g.nodes.get(symbol);
  if (exact) return exact;
  const q = symbol.toLowerCase();
  let best: QNode | undefined;
  let bestScore = 0;
  for (const n of g.nodes.values()) {
    const s = scoreNode(n, q);
    // Prefer code symbols over files/tags when scores tie.
    if (s > bestScore || (s === bestScore && s > 0 && best && best.kind === "file" && n.kind !== "file")) {
      best = n;
      bestScore = s;
    }
  }
  if (!best) {
    throw new Error(`Symbol "${symbol}" not found. Try search_symbols first.`);
  }
  return best;
}

const brief = (n: QNode) => ({
  id: n.id,
  label: n.label,
  kind: n.kind,
  ...(n.file ? { file: n.file } : {}),
  ...(n.line !== undefined ? { line: n.line } : {}),
  ...(n.community !== undefined ? { community: n.community } : {}),
});

function neighbors(g: LoadedGraph, id: string, direction: string): Array<{ node: QNode; relation: string; direction: "in" | "out" }> {
  const res: Array<{ node: QNode; relation: string; direction: "in" | "out" }> = [];
  if (direction !== "in") {
    for (const e of g.out.get(id) ?? []) res.push({ node: g.nodes.get(e.target)!, relation: e.relation, direction: "out" });
  }
  if (direction !== "out") {
    for (const e of g.in.get(id) ?? []) res.push({ node: g.nodes.get(e.source)!, relation: e.relation, direction: "in" });
  }
  return res;
}

// ------------------------------------------------------------------ tools

function listProjects() {
  const projects = local.listProjects().filter((p) => typeof p.nodes === "number");
  return {
    mode: "local",
    count: projects.length,
    projects: projects.map((p) => ({ project: p.project_name, nodes: p.nodes, edges: p.edges, communities: p.communities })),
  };
}

function graphStats(a: Record<string, unknown>) {
  const project = str(a.project);
  const g = load(project);
  const kinds: Record<string, number> = {};
  const relations: Record<string, number> = {};
  const communities = new Set<unknown>();
  for (const n of g.nodes.values()) {
    kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    if (n.community !== undefined) communities.add(n.community);
  }
  for (const list of g.out.values()) for (const e of list) relations[e.relation] = (relations[e.relation] ?? 0) + 1;
  return { project, nodes: g.nodes.size, edges: g.edgeCount, communities: communities.size, nodesByKind: kinds, edgesByRelation: relations };
}

function searchSymbols(a: Record<string, unknown>) {
  const project = str(a.project);
  const query = str(a.query).trim().toLowerCase();
  if (!query) throw new Error("`query` is required.");
  const limit = num(a.limit, 25, 200);
  const g = load(project);
  const hits: Array<{ n: QNode; s: number }> = [];
  for (const n of g.nodes.values()) {
    const s = scoreNode(n, query);
    if (s > 0) hits.push({ n, s });
  }
  hits.sort((x, y) => y.s - x.s || x.n.label.localeCompare(y.n.label));
  return { project, query, total: hits.length, results: hits.slice(0, limit).map((h) => brief(h.n)) };
}

function getNode(a: Record<string, unknown>) {
  const project = str(a.project);
  const g = load(project);
  const node = resolve(g, str(a.symbol));
  const grouped: Record<string, ReturnType<typeof brief>[]> = {};
  const add = (key: string, n: QNode) => (grouped[key] ??= []).push(brief(n));
  for (const nb of neighbors(g, node.id, "both")) {
    const { relation, direction } = nb;
    if (relation === "calls") add(direction === "out" ? "callees" : "callers", nb.node);
    else if (relation === "imports") add(direction === "out" ? "imports" : "imported_by", nb.node);
    else if (relation === "contains" || relation === "defines") add(direction === "out" ? "contains" : "contained_in", nb.node);
    else add(`${relation}_${direction}`, nb.node);
  }
  return { project, node: brief(node), ...grouped };
}

function getNeighbors(a: Record<string, unknown>) {
  const project = str(a.project);
  const direction = ["in", "out", "both"].includes(str(a.direction)) ? str(a.direction) : "both";
  const limit = num(a.limit, 100, 1000);
  const g = load(project);
  const node = resolve(g, str(a.symbol));
  const all = neighbors(g, node.id, direction);
  return {
    project,
    node: brief(node),
    direction,
    total: all.length,
    neighbors: all.slice(0, limit).map((nb) => ({ ...brief(nb.node), relation: nb.relation, direction: nb.direction })),
  };
}

function shortestPath(a: Record<string, unknown>) {
  const project = str(a.project);
  const g = load(project);
  const from = resolve(g, str(a.from));
  const to = resolve(g, str(a.to));
  const prev = new Map<string, { id: string; edge: QEdge } | null>([[from.id, null]]);
  const queue = [from.id];
  while (queue.length && !prev.has(to.id)) {
    const id = queue.shift()!;
    for (const e of [...(g.out.get(id) ?? []), ...(g.in.get(id) ?? [])]) {
      const next = e.source === id ? e.target : e.source;
      if (!prev.has(next)) {
        prev.set(next, { id, edge: e });
        queue.push(next);
      }
    }
  }
  if (!prev.has(to.id)) {
    return { project, from: brief(from), to: brief(to), found: false };
  }
  const steps: Array<{ from: string; relation: string; to: string }> = [];
  const nodes: QNode[] = [to];
  for (let cur = to.id; prev.get(cur); ) {
    const p = prev.get(cur)!;
    steps.unshift({ from: p.edge.source, relation: p.edge.relation, to: p.edge.target });
    nodes.unshift(g.nodes.get(p.id)!);
    cur = p.id;
  }
  return { project, found: true, length: steps.length, path: nodes.map(brief), edges: steps };
}

function impactOfChange(a: Record<string, unknown>) {
  const project = str(a.project);
  const depthMax = num(a.depth, 3, 10);
  const limit = num(a.limit, 200, 2000);
  const g = load(project);
  const node = resolve(g, str(a.symbol));
  // Changing a class/file also changes what it contains.
  const seeds = [node.id];
  for (const e of g.out.get(node.id) ?? []) if (e.relation === "contains" || e.relation === "defines") seeds.push(e.target);
  const depth = new Map<string, number>(seeds.map((s) => [s, 0]));
  const via = new Map<string, string>();
  const queue = [...seeds];
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    if (d >= depthMax) continue;
    for (const e of g.in.get(id) ?? []) {
      if (STRUCTURAL.has(e.relation) || depth.has(e.source)) continue;
      depth.set(e.source, d + 1);
      via.set(e.source, e.relation);
      queue.push(e.source);
    }
  }
  const seedSet = new Set(seeds);
  const impacted = [...depth.entries()]
    .filter(([id]) => !seedSet.has(id))
    .sort((x, y) => x[1] - y[1])
    .map(([id, d]) => ({ ...brief(g.nodes.get(id)!), depth: d, via: via.get(id) }));
  const files = [...new Set(impacted.map((n) => n.file).filter(Boolean))];
  return { project, symbol: brief(node), totalImpacted: impacted.length, impactedFiles: files, impacted: impacted.slice(0, limit) };
}

function godNodes(a: Record<string, unknown>) {
  const project = str(a.project);
  const limit = num(a.limit, 20, 200);
  const g = load(project);
  const ranked = [...g.nodes.values()].map((n) => {
    const inDeg = (g.in.get(n.id) ?? []).filter((e) => !STRUCTURAL.has(e.relation)).length;
    const outDeg = (g.out.get(n.id) ?? []).filter((e) => !STRUCTURAL.has(e.relation)).length;
    return { n, inDeg, outDeg, degree: inDeg + outDeg };
  });
  ranked.sort((x, y) => y.degree - x.degree);
  return {
    project,
    nodes: ranked.slice(0, limit).filter((r) => r.degree > 0).map((r) => ({ ...brief(r.n), degree: r.degree, in: r.inDeg, out: r.outDeg })),
  };
}

const STOP = new Set("the and for with from that this what where which when how does into about are was were is its use used uses using code file files show find list all any".split(" "));

function tokens(question: string): string[] {
  const words = question
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)];
}

function queryGraph(a: Record<string, unknown>) {
  const project = str(a.project);
  const question = str(a.question || a.query);
  const limit = num(a.limit, 150, 1000);
  const g = load(project);
  const terms = tokens(question);
  if (!terms.length) throw new Error("`question` needs at least one keyword (3+ letters).");
  const scored: Array<{ n: QNode; s: number }> = [];
  for (const n of g.nodes.values()) {
    const hay = `${n.label} ${n.id} ${n.file ?? ""}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    let s = 0;
    for (const t of terms) if (hay.includes(t)) s += n.label.toLowerCase().includes(t) ? 3 : 1;
    if (s > 0) scored.push({ n, s });
  }
  scored.sort((x, y) => y.s - x.s);
  const seeds = scored.slice(0, 15).map((x) => x.n.id);
  const keep = new Set(seeds);
  for (const id of seeds) {
    for (const nb of neighbors(g, id, "both")) {
      if (keep.size >= limit) break;
      keep.add(nb.node.id);
    }
  }
  const edges: QEdge[] = [];
  for (const id of keep) for (const e of g.out.get(id) ?? []) if (keep.has(e.target)) edges.push(e);
  return {
    project,
    question,
    keywords: terms,
    seeds: seeds.map((id) => brief(g.nodes.get(id)!)),
    nodes: [...keep].map((id) => brief(g.nodes.get(id)!)),
    edges: edges.slice(0, limit * 3),
  };
}

// ------------------------------------------------------------ AI Context

function contextSave(project: string, context: string) {
  if (!project.trim()) throw new Error("A project name is required.");
  if (!context.trim()) throw new Error("`context` must not be empty.");
  const row = local.saveAiContext({ projectName: project, context });
  return { saved: true, mode: "local", id: row._id, projectName: row.projectName, updatedAt: row.updatedAt };
}

function getProjectContext(a: Record<string, unknown>) {
  const key = str(a.key || a.project);
  const row = local.findAiContextByProject(key);
  if (!row) return { found: false, key };
  return { found: true, key: row.projectName, context: row.context, updatedAt: row.updatedAt };
}

function listProjectContexts() {
  return {
    mode: "local",
    contexts: local.listAiContexts().map((r) => ({
      key: r.projectName,
      preview: r.context.replace(/\s+/g, " ").slice(0, 160),
      updatedAt: r.updatedAt,
    })),
  };
}

// ------------------------------------------------------------ registry

export interface LocalToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>) => unknown;
}

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });
const P = S("Project name (graph tag). Use list_projects to find it.");

export const LOCAL_GRAPH_TOOLS: LocalToolDef[] = [
  { name: "list_projects", description: "List the knowledge graphs available locally, with node/edge counts.", inputSchema: { type: "object", properties: {} }, run: () => listProjects() },
  { name: "graph_stats", description: "Totals and node counts by kind for a project graph.", inputSchema: { type: "object", properties: { project: P }, required: ["project"] }, run: graphStats },
  { name: "search_symbols", description: "Find nodes by name, id or source file.", inputSchema: { type: "object", properties: { project: P, query: S("Text to search for"), limit: N("Max results (default 25)") }, required: ["project", "query"] }, run: searchSymbols },
  { name: "get_node", description: "A symbol with its callers, callees, imports and other relations.", inputSchema: { type: "object", properties: { project: P, symbol: S("Node id or name") }, required: ["project", "symbol"] }, run: getNode },
  { name: "get_neighbors", description: "Direct neighbors of a symbol.", inputSchema: { type: "object", properties: { project: P, symbol: S("Node id or name"), direction: { type: "string", enum: ["in", "out", "both"] }, limit: N("Max neighbors (default 100)") }, required: ["project", "symbol"] }, run: getNeighbors },
  { name: "shortest_path", description: "Dependency path between two symbols.", inputSchema: { type: "object", properties: { project: P, from: S("Start node id or name"), to: S("End node id or name") }, required: ["project", "from", "to"] }, run: shortestPath },
  { name: "impact_of_change", description: "Everything that depends on a symbol (reverse dependencies). Run before editing a symbol.", inputSchema: { type: "object", properties: { project: P, symbol: S("Node id or name"), depth: N("Max hops (default 3)"), limit: N("Max results (default 200)") }, required: ["project", "symbol"] }, run: impactOfChange },
  { name: "god_nodes", description: "Most connected nodes (architectural hubs / hotspots).", inputSchema: { type: "object", properties: { project: P, limit: N("Max results (default 20)") }, required: ["project"] }, run: godNodes },
  { name: "query_graph", description: "Keyword-driven scoped subgraph for a how/where/what question.", inputSchema: { type: "object", properties: { project: P, question: S("Natural-language question"), limit: N("Max nodes (default 150)") }, required: ["project", "question"] }, run: queryGraph },
  { name: "context-save", description: "Create or replace the AI Context record for a project name.", inputSchema: { type: "object", properties: { project: S("Project name (AI Context key)"), context: S("Markdown brief") }, required: ["project", "context"] }, run: (a) => contextSave(str(a.project), str(a.context)) },
  { name: "save_project_context", description: "Same as context-save, with the project name passed as key.", inputSchema: { type: "object", properties: { key: S("Project name (AI Context key)"), context: S("Markdown brief") }, required: ["key", "context"] }, run: (a) => contextSave(str(a.key), str(a.context)) },
  { name: "get_project_context", description: "Fetch the AI Context stored for a project key.", inputSchema: { type: "object", properties: { key: S("Project name (AI Context key)") }, required: ["key"] }, run: getProjectContext },
  { name: "list_project_contexts", description: "List stored AI Context keys with a short preview.", inputSchema: { type: "object", properties: {} }, run: () => listProjectContexts() },
];
