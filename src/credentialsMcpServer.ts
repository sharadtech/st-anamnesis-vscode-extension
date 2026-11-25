import * as http from "http";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fetchCredentialSet, fetchCredentialSets, projectTagsOf } from "./api";
import { decryptCredentialSet, getEncryptionContext } from "./credentialsCrypto";

const DEFAULT_PORT = 17841;
const PORT_RANGE = 20;

export interface CredentialsMcpInfo {
  url: string;
  token: string;
  port: number;
}

let httpServer: http.Server | undefined;
let info: CredentialsMcpInfo | undefined;

const textResult = (data: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
});

function createServer(): McpServer {
  const server = new McpServer({ name: "anamnesis-credentials", version: "1.0.0" });
  const register = server.registerTool.bind(server) as (
    name: string,
    config: { description: string; inputSchema?: Record<string, unknown> },
    handler: (args?: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>,
  ) => void;

  register(
    "list_credential_sets",
    {
      description:
        "List encrypted credential sets stored for this Anamnesis user. Returns names and metadata only, never secret values. Includes whether each set is locked in the sidebar.",
    },
    async () => {
      const rows = await fetchCredentialSets();
      return textResult({
        count: rows.length,
        sets: rows.map((row) => ({
          id: row._id,
          name: row.name,
          description: row.description || "",
          projectTags: projectTagsOf(row),
          keyCount: row.keyCount ?? 0,
          locked: row.locked === true,
          updatedAt: row.updatedAt,
        })),
      });
    },
  );

  register(
    "get_credentials",
    {
      description:
        "Fetch a named Anamnesis credential set, decrypt it inside the local extension, and return plaintext key/value pairs. Use only when the user refers to stored credentials.",
      inputSchema: {
        name: z.string(),
      },
    },
    async (args) => {
      const name = String(args?.name ?? "");
      const wanted = name.trim().toLowerCase();
      const rows = await fetchCredentialSets();
      const match = rows.find((row) => (row.name || "").trim().toLowerCase() === wanted)
        || rows.find((row) => (row.name || "").toLowerCase().includes(wanted));
      if (!match) {
        return textResult(`No credential set named "${name}".`);
      }
      const detail = await fetchCredentialSet(match._id);
      const ctx = await getEncryptionContext();
      const entries = decryptCredentialSet(detail.cipher, ctx);
      return textResult({
        name: detail.name,
        description: detail.description || "",
        projectTags: projectTagsOf(detail),
        entries: entries.map((e) => ({ key: e.key, type: e.type, value: e.value })),
      });
    },
  );

  return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listen(port: number, token: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = req.url || "/";
      const path = url.split("?")[0];
      if (path !== "/mcp" && path !== "/mcp/") {
        res.writeHead(404).end("Not found");
        return;
      }
      const auth = String(req.headers.authorization || "");
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end("Method not allowed");
        return;
      }
      try {
        const body = await readBody(req);
        const mcp = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
            id: null,
          }));
        }
      }
    });

    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export function getCredentialsMcpInfo(): CredentialsMcpInfo | undefined {
  return info;
}

/**
 * Token and port are stored in ~/.anamnesis/credentials-mcp.json (mode 0600),
 * shared by every VS Code and Cursor window. VS Code and Cursor have separate
 * SecretStorage, so a per-app token would make them overwrite each other's
 * entry in the shared ~/.claude.json. A stable value also means MCP clients
 * that loaded their config before this window started keep working.
 */
const STATE_DIR = path.join(os.homedir(), ".anamnesis");
const STATE_FILE = path.join(STATE_DIR, "credentials-mcp.json");
const TAKEOVER_INTERVAL_MS = 30_000;

let starting: Promise<CredentialsMcpInfo> | undefined;
let takeoverTimer: NodeJS.Timeout | undefined;

interface SharedState {
  token: string;
  port?: number;
}

function readSharedState(): SharedState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    if (parsed && typeof parsed.token === "string" && /^[0-9a-f]{48}$/.test(parsed.token)) {
      return parsed;
    }
  } catch {
    // missing or unreadable
  }
  return undefined;
}

function writeSharedState(state: SharedState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function loadOrCreateToken(): string {
  const existing = readSharedState();
  if (existing) {
    return existing.token;
  }
  const token = randomBytes(24).toString("hex");
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    // Exclusive create: if two IDEs start together, only one token wins.
    fs.writeFileSync(STATE_FILE, JSON.stringify({ token }, null, 2) + "\n", {
      encoding: "utf-8", mode: 0o600, flag: "wx",
    });
    return token;
  } catch {
    return readSharedState()?.token ?? token;
  }
}

function preferredPort(): number {
  const saved = readSharedState()?.port;
  return typeof saved === "number" && saved >= DEFAULT_PORT && saved < DEFAULT_PORT + PORT_RANGE
    ? saved
    : DEFAULT_PORT;
}

function rememberPort(token: string, port: number): void {
  try {
    if (readSharedState()?.port !== port) {
      writeSharedState({ token, port });
    }
  } catch {
    // best effort
  }
}

/** True when another Anamnesis window already serves this token on `port`. */
function probeOwnServer(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "GET", timeout: 1500,
        headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        // Our server answers an authorised GET with 405; anything else is not us.
        resolve(res.statusCode === 405);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

function makeInfo(port: number, token: string): CredentialsMcpInfo {
  return { port, token, url: `http://127.0.0.1:${port}/mcp` };
}

/**
 * While another window hosts the server, retry binding the shared port so the
 * endpoint survives that window closing.
 */
function scheduleTakeover(port: number, token: string): void {
  if (takeoverTimer) return;
  takeoverTimer = setInterval(async () => {
    if (httpServer) {
      clearInterval(takeoverTimer);
      takeoverTimer = undefined;
      return;
    }
    if (await probeOwnServer(port, token)) {
      return; // still served by the other window
    }
    try {
      httpServer = await listen(port, token);
      info = makeInfo(port, token);
      clearInterval(takeoverTimer);
      takeoverTimer = undefined;
    } catch {
      // Port held by something else; keep waiting.
    }
  }, TAKEOVER_INTERVAL_MS);
}

export async function stopCredentialsMcpServer(): Promise<void> {
  if (takeoverTimer) {
    clearInterval(takeoverTimer);
    takeoverTimer = undefined;
  }
  const current = httpServer;
  httpServer = undefined;
  info = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

export function startCredentialsMcpServer(): Promise<CredentialsMcpInfo> {
  if (info) {
    return Promise.resolve(info);
  }
  // Concurrent callers (activate + auto-sync) share one start, so only one
  // server is bound and one token is written to the MCP configs.
  if (!starting) {
    starting = doStart().finally(() => {
      starting = undefined;
    });
  }
  return starting;
}

async function doStart(): Promise<CredentialsMcpInfo> {
  const token = loadOrCreateToken();
  const first = preferredPort();
  const order = [first, ...Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i).filter((p) => p !== first)];
  let lastError: unknown;
  for (const port of order) {
    try {
      httpServer = await listen(port, token);
      info = makeInfo(port, token);
      rememberPort(token, port);
      return info;
    } catch (err) {
      lastError = err;
      if (await probeOwnServer(port, token)) {
        // Another VS Code / Cursor window already serves the same token here.
        info = makeInfo(port, token);
        scheduleTakeover(port, token);
        return info;
      }
    }
  }
  throw new Error(
    `Could not bind the local credentials MCP server near port ${DEFAULT_PORT}: ${
      lastError instanceof Error ? lastError.message : lastError
    }`
  );
}
