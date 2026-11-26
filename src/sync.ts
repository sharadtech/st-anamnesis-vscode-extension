/**
 * Uploads everything in the local store to Anamnesis Cloud once it is
 * reachable, then deletes each local item as soon as the server confirms it.
 *
 * Order: graphs -> AI Context -> prompts -> credentials, so a project exists
 * before its prompts arrive. Name clashes with existing cloud items are
 * resolved by asking the user (overwrite / keep both / skip). Skipped and
 * failed items stay local and are retried on the next sync.
 */
import * as fs from "fs";
import * as path from "path";
import * as cloud from "./cloudApi";
import * as local from "./localStore";
import { deleteLocalKey, reencryptFor } from "./credentialsCrypto";

export type ConflictKind = "graph" | "aiContext" | "credentials";
export type ConflictChoice = "overwrite" | "rename" | "skip";

export interface SyncUi {
  /** Ask how to resolve a name clash. Returning "skip" keeps the item local. */
  askConflict(kind: ConflictKind, name: string, renamedTo: string): Promise<ConflictChoice>;
  progress(message: string): void;
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  failed: number;
  errors: string[];
  /** True when the run stopped early because the cloud became unreachable. */
  aborted: boolean;
}

const LOCK_STALE_MS = 10 * 60_000;
const lockFile = () => path.join(local.localRoot(), ".sync.lock");

/** One sync at a time across all VS Code / Cursor windows. */
function acquireLock(): boolean {
  fs.mkdirSync(local.localRoot(), { recursive: true, mode: 0o700 });
  const file = lockFile();
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        return acquireLock();
      }
    } catch {
      // raced with another window
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(lockFile());
  } catch {
    // already gone
  }
}

export const renamed = (name: string) => `${name} (local)`;
const lc = (s: string) => s.trim().toLowerCase();

class Abort extends Error {}

/** Returns undefined when another window is already syncing. */
export async function syncLocalToCloud(ui: SyncUi): Promise<SyncResult | undefined> {
  if (local.isEmpty()) {
    return { uploaded: 0, skipped: 0, failed: 0, errors: [], aborted: false };
  }
  if (!acquireLock()) {
    return undefined;
  }
  const result: SyncResult = { uploaded: 0, skipped: 0, failed: 0, errors: [], aborted: false };

  /** Run one upload; a network failure aborts the whole run (retried later). */
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      result.uploaded++;
    } catch (err) {
      if (cloud.isNetworkError(err)) {
        throw new Abort(err instanceof Error ? err.message : String(err));
      }
      result.failed++;
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    // Project names whose graph was uploaded under a new name.
    const projectRename = new Map<string, string>();

    // ---- graphs
    const graphNames = local.listGraphNames();
    if (graphNames.length) {
      ui.progress(`Uploading ${graphNames.length} knowledge graph(s)…`);
      const cloudProjects = new Set(
        (await cloud.fetchProjects()).projects
          .filter((p) => p.shared !== true)
          .map((p) => lc(String(p.graph_tag || p.project_name)))
      );
      for (const name of graphNames) {
        let target = name;
        if (cloudProjects.has(lc(name))) {
          const choice = await ui.askConflict("graph", name, renamed(name));
          if (choice === "skip") {
            result.skipped++;
            continue;
          }
          if (choice === "rename") target = renamed(name);
        }
        const graph = local.readSerializedGraph(name);
        if (!graph) continue;
        await attempt(`Graph "${name}"`, async () => {
          await cloud.createRepo(target);
          await cloud.uploadGraph(target, graph);
          local.deleteGraph(name);
          if (target !== name) projectRename.set(name, target);
        });
      }
    }

    // ---- AI Context
    const contexts = local.listAiContexts();
    if (contexts.length) {
      ui.progress(`Uploading ${contexts.length} AI Context record(s)…`);
      const cloudRows = await cloud.fetchAiContexts();
      for (const row of contexts) {
        const existing = cloudRows.find((r) => lc(r.projectName) === lc(row.projectName));
        let choice: ConflictChoice | undefined;
        if (existing) {
          choice = await ui.askConflict("aiContext", row.projectName, renamed(row.projectName));
          if (choice === "skip") {
            result.skipped++;
            continue;
          }
        }
        await attempt(`AI Context "${row.projectName}"`, async () => {
          const body = { projectName: row.projectName, context: row.context };
          if (existing && choice === "overwrite") {
            await cloud.updateAiContext(existing._id, body);
          } else {
            await cloud.saveAiContext(choice === "rename" ? { ...body, projectName: renamed(row.projectName) } : body);
          }
          local.deleteAiContext(row._id);
        });
      }
    }

    // ---- prompts (never clash: always added as new rows)
    for (const project of local.listPromptProjects()) {
      const rows = local.listPrompts(project);
      if (!rows.length) continue;
      const target = projectRename.get(project) ?? project;
      ui.progress(`Uploading ${rows.length} prompt(s) for "${target}"…`);
      for (const row of rows) {
        await attempt(`Prompt "${row.title}"`, async () => {
          await cloud.createPrompt(target, {
            title: row.title,
            prompt: row.prompt,
            promptParameters: row.promptParameters,
            // Cloud generates the AI-improved prompt now, if it was wanted.
            skipAiGeneration: !row.wantAi,
          });
          local.deletePrompt(project, row._id);
        });
      }
    }

    // ---- credentials (decrypt with the local key, re-encrypt for the cloud)
    const creds = local.listCredentialSetDetails();
    if (creds.length) {
      ui.progress(`Uploading ${creds.length} credential set(s)…`);
      const cloudSets = await cloud.fetchCredentialSets();
      for (const row of creds) {
        const existing = cloudSets.find((r) => lc(r.name) === lc(row.name));
        let choice: ConflictChoice | undefined;
        if (existing) {
          choice = await ui.askConflict("credentials", row.name, renamed(row.name));
          if (choice === "skip") {
            result.skipped++;
            continue;
          }
        }
        await attempt(`Credentials "${row.name}"`, async () => {
          const body = {
            name: choice === "rename" ? renamed(row.name) : row.name,
            description: row.description,
            projectTags: row.projectTags,
            keyCount: row.keyCount ?? 0,
            cipher: await reencryptFor("cloud", row.cipher),
          };
          const saved =
            existing && choice === "overwrite"
              ? await cloud.updateCredentialSet(existing._id, body)
              : await cloud.createCredentialSet(body);
          if (row.locked && saved?._id) {
            await cloud.setCredentialSetLocked(saved._id, true);
          }
          local.deleteCredentialSet(row._id);
        });
      }
    }
  } catch (err) {
    if (err instanceof Abort || cloud.isNetworkError(err)) {
      result.aborted = true;
      result.errors.push(`Stopped: Anamnesis Cloud became unreachable (${err instanceof Error ? err.message : err}).`);
    } else {
      throw err;
    }
  } finally {
    if (local.listCredentialSets().length === 0) {
      deleteLocalKey();
    }
    releaseLock();
  }
  return result;
}
