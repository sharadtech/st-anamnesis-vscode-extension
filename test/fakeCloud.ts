/** In-memory stand-in for the Anamnesis Cloud REST API + MCP endpoint. */
import * as http from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const CLIENT_ID = "cid";
export const SECRET_KEY = "sk";
export const USER = { userId: "u1", companyId: "c1", keyId: "k1", keyName: "Test key", role: "admin" };

export class FakeCloud {
  graphs = new Map<string, unknown>();
  repos = new Set<string>();
  prompts = new Map<string, any[]>();
  aiContexts: any[] = [];
  credentials: any[] = [];
  /** Request paths (method + path) that should answer HTTP 500 once. */
  failOnce = new Set<string>();
  /** Bodies of created prompts, for assertions. */
  promptBodies: any[] = [];
  mcpCalls: string[] = [];
  private server?: http.Server;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url || "/", "http://x");
    const p = url.pathname.replace(/^\/anamnesis-vscode-ext/, "");
    const key = `${req.method} ${p}`;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status < 400 ? { data } : { message: String(data) }));
    };

    if (p === "/mcp") {
      return this.mcp(req, res, body);
    }
    if (p === "/authenticate") {
      return body?.clientId === CLIENT_ID && body?.secretKey === SECRET_KEY
        ? send(200, USER)
        : send(401, "Invalid credentials");
    }
    if (req.headers["x-client-id"] !== CLIENT_ID || req.headers["x-secret-key"] !== SECRET_KEY) {
      return send(401, "Unauthorized");
    }
    if (this.failOnce.has(key)) {
      this.failOnce.delete(key);
      return send(500, "Injected failure");
    }
    const parts = p.split("/").filter(Boolean).map(decodeURIComponent);
    const now = new Date().toISOString();

    // projects / graphs
    if (key === "GET /projects") {
      const projects = [...this.graphs.entries()].map(([name, g]: [string, any]) => ({
        project_name: name, graph_tag: name, nodes: g.nodes.length, edges: g.edges.length,
      }));
      return send(200, { projects, count: projects.length });
    }
    if (key === "POST /repos") {
      this.repos.add(body.projectName);
      return send(200, { ok: true });
    }
    if (parts[0] === "graphs" && parts.length === 2) {
      if (req.method === "PUT") {
        this.graphs.set(parts[1], body);
        return send(200, { ok: true });
      }
      if (req.method === "GET") {
        const g: any = this.graphs.get(parts[1]);
        return g ? send(200, { tag: parts[1], nodes: g.nodes, edges: g.edges }) : send(404, "Not found");
      }
      if (req.method === "DELETE") {
        return this.graphs.delete(parts[1]) ? send(200, { ok: true, tag: parts[1], deleted: ["graph"] }) : send(404, "Not found");
      }
    }
    // prompts
    if (parts[0] === "projects" && parts[2] === "prompts") {
      const rows = this.prompts.get(parts[1]) ?? [];
      if (req.method === "GET") return send(200, rows);
      if (req.method === "POST") {
        this.promptBodies.push({ project: parts[1], ...body });
        const row = { _id: randomUUID(), ...body, aiCreatedPrompt: "", precision: 0, status: body.skipAiGeneration ? "ready" : "processing", updatedAt: now };
        rows.push(row);
        this.prompts.set(parts[1], rows);
        return send(200, row);
      }
    }
    // AI Context
    if (parts[0] === "ai-context") {
      if (req.method === "GET" && parts.length === 1) return send(200, this.aiContexts);
      if (req.method === "POST") {
        const row = { _id: randomUUID(), ...body, updatedAt: now };
        this.aiContexts.push(row);
        return send(200, row);
      }
      if (req.method === "PUT") {
        const row = this.aiContexts.find((r) => r._id === parts[1]);
        if (!row) return send(404, "Not found");
        Object.assign(row, body, { updatedAt: now });
        return send(200, row);
      }
    }
    // credentials
    if (parts[0] === "credentials") {
      if (req.method === "GET" && parts.length === 1) return send(200, this.credentials.map(({ cipher, ...r }) => r));
      if (req.method === "GET") {
        const row = this.credentials.find((r) => r._id === parts[1]);
        return row ? send(200, row) : send(404, "Not found");
      }
      if (req.method === "POST") {
        const row = { _id: randomUUID(), ...body, locked: false, updatedAt: now };
        this.credentials.push(row);
        return send(200, row);
      }
      if (req.method === "PUT") {
        const row = this.credentials.find((r) => r._id === parts[1]);
        if (!row) return send(404, "Not found");
        Object.assign(row, body, { updatedAt: now });
        return send(200, row);
      }
      if (req.method === "PATCH" && parts[2] === "lock") {
        const row = this.credentials.find((r) => r._id === parts[1]);
        if (!row) return send(404, "Not found");
        row.locked = body.locked;
        return send(200, row);
      }
    }
    send(404, `No route ${key}`);
  }

  private async mcp(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
    if (req.headers["x-client-id"] !== CLIENT_ID || req.headers["x-secret-key"] !== SECRET_KEY) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = new McpServer({ name: "fake-cloud", version: "1.0.0" });
    server.registerTool("list_projects", { description: "cloud projects" }, async () => {
      this.mcpCalls.push("list_projects");
      return { content: [{ type: "text", text: JSON.stringify({ mode: "cloud", projects: [...this.graphs.keys()] }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
