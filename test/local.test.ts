import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as local from "../src/localStore";
import { LOCAL_GRAPH_TOOLS } from "../src/graphQuery";
import {
  decryptCredentialSet,
  encryptCredentialSet,
  getEncryptionContext,
  getLocalEncryptionContext,
  isLocalCipher,
} from "../src/credentialsCrypto";
import { getModeState, probe } from "../src/mode";
import * as api from "../src/api";
import { FIXTURE } from "./fixture";

const tool = (name: string, args: Record<string, unknown> = {}) => {
  const t = LOCAL_GRAPH_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t!.run(args) as any;
};

test("HOME is a throwaway directory", () => {
  assert.ok(os.homedir().includes("anamnesis-home-"), os.homedir());
});

test("graphs: save, list, webview shape, stats, delete", () => {
  local.saveGraph("demo", FIXTURE);
  assert.deepEqual(local.listGraphNames(), ["demo"]);
  const [p] = local.listProjects();
  assert.equal(p.project_name, "demo");
  assert.equal(p.nodes, 7);
  assert.equal(p.local, true);
  const g = local.getGraph("demo");
  const run = g.nodes.find((n) => n.id === "a.ts#Service.run")!;
  assert.equal(run.source_file, "a.ts");
  assert.equal(run.loc, "L5");
  assert.deepEqual(local.getStats("demo"), { tag: "demo", nodes: 7, edges: 6, communities: 2, built_at_commit: null });
  const mode = fs.statSync(path.join(local.localRoot(), "graphs", "demo.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("prompts: create/update/delete, prompt-only project is listed", () => {
  const row = local.createPrompt("other", { title: "T", prompt: "P", skipAiGeneration: false });
  assert.ok(local.isLocalId(row._id));
  assert.equal(row.wantAi, true);
  assert.ok(local.listProjects().some((p) => p.project_name === "other"));
  local.updatePrompt("other", row._id, { title: "T2", prompt: "P2", skipAiGeneration: true });
  assert.equal(local.listPrompts("other")[0].title, "T2");
  assert.equal(local.listPrompts("other")[0].wantAi, false);
  assert.equal(local.deletePrompt("other", row._id), true);
  assert.equal(local.listPrompts("other").length, 0);
  assert.ok(!local.listProjects().some((p) => p.project_name === "other"));
});

test("AI Context: upsert by project name (case-insensitive)", () => {
  const a = local.saveAiContext({ projectName: "Demo", context: "v1" });
  const b = local.saveAiContext({ projectName: "demo", context: "v2" });
  assert.equal(a._id, b._id);
  assert.equal(local.listAiContexts().length, 1);
  assert.equal(local.getAiContext(a._id).context, "v2");
});

test("graph tools answer from the local graph", () => {
  assert.equal(tool("list_projects").projects[0].project, "demo");
  assert.equal(tool("graph_stats", { project: "demo" }).nodesByKind.class, 2);
  assert.equal(tool("search_symbols", { project: "demo", query: "serv" }).results[0].label, "Service");
  const node = tool("get_node", { project: "demo", symbol: "run" });
  assert.deepEqual(node.callers.map((n: any) => n.label), ["handle"]);
  assert.deepEqual(node.callees.map((n: any) => n.label), ["helper"]);
  assert.deepEqual(node.contained_in.map((n: any) => n.label), ["Service"]);
  assert.equal(tool("get_neighbors", { project: "demo", symbol: "helper", direction: "in" }).neighbors[0].label, "run");
  const path1 = tool("shortest_path", { project: "demo", from: "handle", to: "helper" });
  assert.equal(path1.found, true);
  assert.deepEqual(path1.path.map((n: any) => n.label), ["handle", "run", "helper"]);
  const impact = tool("impact_of_change", { project: "demo", symbol: "helper" });
  assert.deepEqual(impact.impacted.map((n: any) => n.label), ["run", "handle"]);
  assert.deepEqual(impact.impactedFiles, ["a.ts", "b.ts"]);
  // Changing the Service class also impacts callers of its methods.
  assert.ok(tool("impact_of_change", { project: "demo", symbol: "Service" }).impacted.some((n: any) => n.label === "handle"));
  assert.equal(tool("god_nodes", { project: "demo" }).nodes[0].label, "run");
  const q = tool("query_graph", { project: "demo", question: "How does the Controller handle requests?" });
  assert.ok(q.nodes.some((n: any) => n.label === "run"));
  assert.throws(() => tool("graph_stats", { project: "nope" }), /No local knowledge graph named "nope"/);
});

test("AI Context tools work locally", () => {
  tool("context-save", { project: "Brief", context: "# hello" });
  assert.equal(tool("get_project_context", { key: "brief" }).context, "# hello");
  tool("save_project_context", { key: "Brief", context: "# v2" });
  assert.equal(tool("get_project_context", { key: "Brief" }).context, "# v2");
  assert.ok(tool("list_project_contexts").contexts.some((c: any) => c.key === "Brief"));
  assert.equal(tool("get_project_context", { key: "missing" }).found, false);
});

test("credentials: local key encrypts and decrypts, key file is 0600", async () => {
  await probe(); // no credentials configured -> local mode
  assert.equal(getModeState().mode, "local");
  assert.equal(getModeState().reason, "no-credentials");
  const ctx = await getEncryptionContext();
  assert.equal(ctx.keyId, "anamnesis-local");
  const entries = [{ key: "DB_PASSWORD", type: "password" as const, value: "s3cret" }];
  const cipher = encryptCredentialSet(entries, ctx);
  assert.ok(isLocalCipher(cipher));
  assert.ok(!JSON.stringify(cipher).includes("s3cret"));
  // Decrypt picks the local key even if handed some other context.
  assert.deepEqual(decryptCredentialSet(cipher, { ...ctx, keyId: "x", secretKey: "wrong" }), entries);
  const keyFile = path.join(os.homedir(), ".anamnesis", "local.key");
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(getLocalEncryptionContext().secretKey, ctx.secretKey);
});

test("router: no credentials -> everything goes to the local store", async () => {
  const p = await api.createPrompt("demo", { title: "x", prompt: "y" });
  assert.ok(api.isLocalId(p._id));
  const ctx = await api.saveAiContext({ projectName: "routed", context: "c" });
  assert.ok(api.isLocalId(ctx._id));
  const cipher = encryptCredentialSet([{ key: "K", type: "text", value: "V" }], await getEncryptionContext());
  const set = await api.createCredentialSet({ name: "Prod", keyCount: 1, cipher });
  assert.ok(api.isLocalId(set._id));
  const detail = await api.fetchCredentialSet(set._id);
  assert.deepEqual(decryptCredentialSet(detail.cipher, await getEncryptionContext())[0].value, "V");
  assert.equal(await api.saveGraph("g2", FIXTURE), "local");
  assert.ok((await api.fetchProjects()).projects.some((x) => x.project_name === "g2"));
  assert.equal((await api.fetchGraph("g2")).nodes.length, 7);
  const del = await api.deleteGraph("g2");
  assert.deepEqual(del.deleted, ["local graph g2"]);
});
