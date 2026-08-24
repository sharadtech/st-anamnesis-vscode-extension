import * as http from "http";
import { randomBytes } from "crypto";
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
        "List encrypted credential sets stored for this Anamnesis user. Returns names and metadata only, never secret values.",
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

export async function stopCredentialsMcpServer(): Promise<void> {
  const current = httpServer;
  httpServer = undefined;
  info = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

export async function startCredentialsMcpServer(): Promise<CredentialsMcpInfo> {
  if (httpServer && info) {
    return info;
  }
  await stopCredentialsMcpServer();
  const token = randomBytes(24).toString("hex");
  let lastError: unknown;
  for (let i = 0; i < PORT_RANGE; i++) {
    const port = DEFAULT_PORT + i;
    try {
      httpServer = await listen(port, token);
      info = {
        port,
        token,
        url: `http://127.0.0.1:${port}/mcp`,
      };
      return info;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not bind the local credentials MCP server near port ${DEFAULT_PORT}: ${
      lastError instanceof Error ? lastError.message : lastError
    }`
  );
}
