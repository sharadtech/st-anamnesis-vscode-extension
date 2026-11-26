import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as api from "../src/api";
import * as local from "../src/localStore";
import { getModeState, probe } from "../src/mode";
import {
  decryptCredentialSet,
  encryptCredentialSet,
  getCloudEncryptionContext,
  getEncryptionContext,
  getLocalEncryptionContext,
  isLocalCipher,
} from "../src/credentialsCrypto";
import { ConflictChoice, ConflictKind, syncLocalToCloud } from "../src/sync";
import { startCredentialsMcpServer, stopCredentialsMcpServer } from "../src/credentialsMcpServer";
import { CLIENT_ID, FakeCloud, SECRET_KEY } from "./fakeCloud";
import { FIXTURE } from "./fixture";

const cfg = (globalThis as any).__anamnesisConfig as Record<string, string>;
const cloud = new FakeCloud();
let port = 0;

const ui = (answers: Partial<Record<string, ConflictChoice>> = {}) => {
  const asked: string[] = [];
  return {
    asked,
    progress: () => undefined,
    askConflict: async (kind: ConflictKind, name: string) => {
      asked.push(`${kind}:${name}`);
      return answers[`${kind}:${name}`] ?? "skip";
    },
  };
};

const goOffline = async () => {
  await cloud.stop();
  await probe();
  assert.equal(getModeState().mode, "local");
  assert.equal(getModeState().reason, "unreachable");
};

const goOnline = async () => {
  await cloud.start(port);
  await probe();
  assert.equal(getModeState().mode, "cloud", getModeState().detail);
};

before(async () => {
  await cloud.start();
  port = cloud.port;
  Object.assign(cfg, { serverUrl: cloud.url, clientId: CLIENT_ID, secretKey: SECRET_KEY });
});

after(async () => {
  await stopCredentialsMcpServer();
  await cloud.stop();
});

test("probe: good credentials -> cloud; wrong ones -> local (auth-failed)", async () => {
  cfg.secretKey = "wrong";
  await probe();
  assert.equal(getModeState().mode, "local");
  assert.equal(getModeState().reason, "auth-failed");
  cfg.secretKey = SECRET_KEY;
  await probe();
  assert.equal(getModeState().mode, "cloud");
  assert.equal(getModeState().user?.userId, "u1");
});

test("cloud mode: writes go to the cloud", async () => {
  assert.equal(await api.saveGraph("demo", FIXTURE), "cloud");
  assert.ok(cloud.graphs.has("demo"));
  const p = await api.createPrompt("demo", { title: "cloud prompt", prompt: "x" });
  assert.ok(!api.isLocalId(p._id));
  assert.equal(local.isEmpty(), true);
});

test("network failure mid-session: write lands locally and mode flips", async () => {
  await cloud.stop();
  const row = await api.saveAiContext({ projectName: "Offline", context: "typed while offline" });
  assert.ok(api.isLocalId(row._id));
  assert.equal(getModeState().mode, "local");
  assert.equal(getModeState().reason, "unreachable");
  await cloud.start(port);
});

test("offline: build up local data, including name clashes with the cloud", async () => {
  await goOnline();
  cloud.aiContexts.push({ _id: "ctx-1", projectName: "Demo", context: "cloud version" });
  const cloudCipher = encryptCredentialSet([{ key: "OLD", type: "text", value: "cloud" }], await getCloudEncryptionContext());
  cloud.credentials.push({ _id: "cred-1", name: "Prod", keyCount: 1, cipher: cloudCipher, locked: false });
  await goOffline();

  assert.equal(await api.saveGraph("demo", FIXTURE), "local"); // clashes with cloud "demo"
  assert.equal(await api.saveGraph("fresh", FIXTURE), "local");
  await api.saveAiContext({ projectName: "Demo", context: "local version" }); // clashes
  await api.createPrompt("demo", { title: "p1", prompt: "improve me", skipAiGeneration: false });
  await api.createPrompt("fresh", { title: "p2", prompt: "as is", skipAiGeneration: true });
  const ctx = await getEncryptionContext();
  assert.equal(ctx.keyId, "anamnesis-local");
  const prod = encryptCredentialSet([{ key: "DB", type: "password", value: "local-prod" }], ctx);
  await api.createCredentialSet({ name: "Prod", keyCount: 1, cipher: prod }); // clashes
  const fresh = await api.createCredentialSet({
    name: "New",
    keyCount: 1,
    cipher: encryptCredentialSet([{ key: "TOKEN", type: "password", value: "t0k" }], ctx),
  });
  await api.setCredentialSetLocked(fresh._id, true);
  assert.deepEqual(local.counts(), { graphs: 2, prompts: 2, aiContexts: 2, credentials: 2 });
  // Local credential blobs never hold plaintext.
  assert.ok(!fs.readFileSync(path.join(local.localRoot(), "credentials.json"), "utf-8").includes("local-prod"));
});

test("sync: aborts cleanly when the cloud is unreachable", async () => {
  // Mode says cloud but the server is gone: nothing is deleted locally.
  await goOnline();
  await cloud.stop();
  const res = await syncLocalToCloud(ui());
  assert.equal(res?.aborted, true);
  assert.equal(local.counts().graphs, 2);
  await cloud.start(port);
});

test("sync: uploads, asks per conflict, deletes only what the server confirmed", async () => {
  await goOnline();
  cloud.failOnce.add("POST /projects/fresh/prompts"); // one upload fails
  const u = ui({ "graph:demo": "rename", "aiContext:Demo": "overwrite", "credentials:Prod": "skip" });
  const res = await syncLocalToCloud(u);
  assert.ok(res);
  assert.deepEqual(u.asked.sort(), ["aiContext:Demo", "credentials:Prod", "graph:demo"]);
  assert.equal(res.failed, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.aborted, false);

  // graphs: "demo" uploaded as "demo (local)", "fresh" as-is
  assert.ok(cloud.graphs.has("demo (local)") && cloud.graphs.has("fresh") && cloud.repos.has("demo (local)"));
  // prompts follow the renamed project and keep the AI choice
  assert.deepEqual(
    cloud.promptBodies.filter((b) => b.title === "p1").map((b) => [b.project, b.skipAiGeneration]),
    [["demo (local)", false]]
  );
  // AI Context: cloud record overwritten; the offline-typed record uploaded
  assert.equal(cloud.aiContexts.find((r) => r._id === "ctx-1").context, "local version");
  assert.ok(cloud.aiContexts.some((r) => r.projectName === "Offline"));
  // credentials: "New" re-encrypted for the cloud, lock preserved; "Prod" skipped
  const uploaded = cloud.credentials.find((r) => r.name === "New");
  assert.ok(uploaded && !isLocalCipher(uploaded.cipher) && uploaded.locked === true);
  assert.equal(decryptCredentialSet(uploaded.cipher, await getCloudEncryptionContext())[0].value, "t0k");
  assert.equal(cloud.credentials.find((r) => r._id === "cred-1").keyCount, 1);

  // local store keeps only the skipped + failed items
  assert.deepEqual(local.counts(), { graphs: 0, prompts: 1, aiContexts: 0, credentials: 1 });
  assert.equal(local.listPrompts("fresh")[0].title, "p2");
  assert.ok(fs.existsSync(path.join(os.homedir(), ".anamnesis", "local.key")), "key kept while a local set remains");
});

test("sync: second run resolves the rest; local store and key are removed", async () => {
  const res = await syncLocalToCloud(ui({ "credentials:Prod": "overwrite" }));
  assert.equal(res?.failed, 0);
  assert.equal(local.isEmpty(), true);
  const prod = cloud.credentials.find((r) => r._id === "cred-1");
  assert.equal(decryptCredentialSet(prod.cipher, await getCloudEncryptionContext())[0].value, "local-prod");
  assert.ok(!fs.existsSync(path.join(os.homedir(), ".anamnesis", "local.key")));
  assert.ok(cloud.promptBodies.some((b) => b.title === "p2" && b.skipAiGeneration === true));
});

test("cloud mode lists also show unsynced local items", async () => {
  await goOffline();
  await api.saveAiContext({ projectName: "Pending", context: "x" });
  await goOnline();
  const rows = await api.fetchAiContexts();
  assert.ok(rows.some((r) => r.projectName === "Pending" && api.isLocalId(r._id)));
  assert.ok(rows.some((r) => r._id === "ctx-1"));
  await syncLocalToCloud(ui());
  assert.equal(local.isEmpty(), true);
});

async function mcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  );
  return client;
}

const text = (r: any) => JSON.parse(r.content[0].text);

test("gateway: relays to the cloud online, answers locally offline, same session", async () => {
  await goOnline();
  const info = await startCredentialsMcpServer();
  const client = await mcpClient(info.graphUrl, info.token);

  // Online: relayed to the cloud MCP server.
  const online = text(await client.callTool({ name: "list_projects", arguments: {} }));
  assert.equal(online.mode, "cloud");
  assert.ok(cloud.mcpCalls.includes("list_projects"));

  // Offline: same client, no reconnect, answered from the local store.
  await goOffline();
  local.saveGraph("offline-graph", FIXTURE);
  const offline = text(await client.callTool({ name: "list_projects", arguments: {} }));
  assert.equal(offline.mode, "local");
  assert.deepEqual(offline.projects.map((p: any) => p.project), ["offline-graph"]);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("impact_of_change") && tools.includes("context-save"));
  const saved = text(await client.callTool({ name: "context-save", arguments: { project: "via-mcp", context: "# brief" } }));
  assert.equal(saved.mode, "local");
  assert.equal(local.findAiContextByProject("via-mcp")?.context, "# brief");

  // Back online: relayed again.
  await goOnline();
  assert.equal(text(await client.callTool({ name: "list_projects", arguments: {} })).mode, "cloud");
  await client.close();
});

test("gateway: credentials endpoint decrypts local sets offline; bad token rejected", async () => {
  await goOffline();
  const ctx = getLocalEncryptionContext();
  await api.createCredentialSet({
    name: "Offline DB",
    keyCount: 1,
    cipher: encryptCredentialSet([{ key: "URL", type: "text", value: "postgres://x" }], ctx),
  });
  const info = await startCredentialsMcpServer();
  const client = await mcpClient(info.url, info.token);
  const list = text(await client.callTool({ name: "list_credential_sets", arguments: {} }));
  assert.ok(list.sets.some((s: any) => s.name === "Offline DB"));
  const got = text(await client.callTool({ name: "get_credentials", arguments: { name: "offline db" } }));
  assert.equal(got.entries[0].value, "postgres://x");
  await client.close();

  const res = await fetch(info.graphUrl, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
  assert.equal(res.status, 401);
});
