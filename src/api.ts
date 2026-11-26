/**
 * API used by the UI, MCP servers and graph generation. Every call is routed
 * to Anamnesis Cloud (cloudApi.ts) or to the local store (localStore.ts):
 *
 *  - local mode (no credentials / unreachable / rejected)  -> local store
 *  - cloud mode                                            -> cloud; on a network
 *    error the extension switches to local mode and the call is served locally,
 *    so nothing typed by the user is lost
 *  - ids starting with "local-" always go to the local store (items waiting
 *    for sync, or skipped during a sync conflict)
 *
 * Lists in cloud mode also include local items that have not been uploaded.
 */
import * as cloud from "./cloudApi";
import * as local from "./localStore";
import { isLocalId } from "./localStore";
import { isLocalMode, markOffline, modeReady } from "./mode";
import { reencryptFor } from "./credentialsCrypto";
import type {
  AiContextRow,
  CipherBlob,
  CredentialSetDetail,
  CredentialSetRow,
  GraphData,
  GraphStats,
  ProjectMeta,
  PromptRow,
  SerializedGraphPayload,
} from "./cloudApi";

export type {
  AiContextRow,
  AuthUser,
  CipherBlob,
  CredentialSetDetail,
  CredentialSetRow,
  GraphData,
  GraphEdge,
  GraphNode,
  GraphStats,
  ProjectMeta,
  PromptRow,
  SerializedGraphPayload,
} from "./cloudApi";
export { config, fetchAuthUser, isNetworkError, projectTagsOf, testConnection } from "./cloudApi";
export { isLocalId } from "./localStore";

/**
 * Run `cloudCall` unless in local mode. A network failure flips to local mode
 * and runs `localCall` instead.
 */
async function route<T>(cloudCall: () => Promise<T>, localCall: () => T | Promise<T>): Promise<T> {
  await modeReady();
  if (isLocalMode()) {
    return localCall();
  }
  try {
    return await cloudCall();
  } catch (err) {
    if (cloud.isNetworkError(err)) {
      markOffline(err instanceof Error ? err.message : String(err));
      return localCall();
    }
    throw err;
  }
}

/** Cloud list plus local rows that are not yet uploaded. */
async function merged<T>(cloudCall: () => Promise<T[]>, localCall: () => T[]): Promise<T[]> {
  let usedLocal = false;
  const rows = await route(cloudCall, () => {
    usedLocal = true;
    return localCall();
  });
  return usedLocal ? rows : [...rows, ...localCall()];
}

// ---------------------------------------------------------------- graphs

export async function fetchProjects(): Promise<{ projects: ProjectMeta[]; count: number }> {
  const projects = await merged(
    async () => (await cloud.fetchProjects()).projects,
    () => local.listProjects()
  );
  return { projects, count: projects.length };
}

export async function fetchGraph(tag?: string): Promise<GraphData> {
  const name = tag || cloud.config().defaultTag;
  return route(
    async () => {
      try {
        return await cloud.fetchGraph(name);
      } catch (err) {
        // Cloud has no such project, but a not-yet-uploaded local copy exists.
        if (!cloud.isNetworkError(err) && local.hasGraph(name)) {
          return local.getGraph(name);
        }
        throw err;
      }
    },
    () => local.getGraph(name)
  );
}

export async function fetchStats(tag?: string): Promise<GraphStats> {
  const name = tag || cloud.config().defaultTag;
  return route(
    async () => {
      try {
        return await cloud.fetchStats(name);
      } catch (err) {
        if (!cloud.isNetworkError(err) && local.hasGraph(name)) {
          return local.getStats(name);
        }
        throw err;
      }
    },
    () => local.getStats(name)
  );
}

/** Save a freshly generated graph. Returns where it was stored. */
export async function saveGraph(
  projectName: string,
  graph: SerializedGraphPayload
): Promise<"cloud" | "local"> {
  return route<"cloud" | "local">(
    async () => {
      await cloud.createRepo(projectName);
      await cloud.uploadGraph(projectName, graph);
      // A fresh cloud upload supersedes any copy waiting for sync.
      local.deleteGraph(projectName);
      return "cloud";
    },
    () => {
      local.saveGraph(projectName, graph);
      return "local";
    }
  );
}

export async function deleteGraph(tag: string): Promise<{ ok: boolean; tag: string; deleted: string[] }> {
  const localDeleted = () => local.deleteGraph(tag);
  return route(
    async () => {
      let res: { ok: boolean; tag: string; deleted: string[] } | undefined;
      try {
        res = await cloud.deleteGraph(tag);
      } catch (err) {
        if (cloud.isNetworkError(err) || !local.hasGraph(tag)) {
          throw err;
        }
      }
      const deleted = [...(res?.deleted ?? []), ...localDeleted()];
      return { ok: true, tag, deleted };
    },
    () => ({ ok: true, tag, deleted: localDeleted() })
  );
}

// ---------------------------------------------------------------- prompts

export async function fetchPrompts(projectName: string): Promise<PromptRow[]> {
  return merged(
    () => cloud.fetchPrompts(projectName),
    () => local.listPrompts(projectName)
  );
}

export async function createPrompt(
  projectName: string,
  body: { title: string; prompt: string; promptParameters?: string; skipAiGeneration?: boolean }
): Promise<PromptRow> {
  return route(
    () => cloud.createPrompt(projectName, body),
    () => local.createPrompt(projectName, body)
  );
}

export async function updatePrompt(
  projectName: string,
  promptId: string,
  body: {
    title: string;
    prompt: string;
    promptParameters?: string;
    validateWithAi?: boolean;
    skipAiGeneration?: boolean;
  }
): Promise<PromptRow> {
  if (isLocalId(promptId)) {
    return local.updatePrompt(projectName, promptId, body);
  }
  return cloud.updatePrompt(projectName, promptId, body);
}

export async function deletePromptEntry(
  projectName: string,
  promptId: string
): Promise<{ deleted: boolean }> {
  if (isLocalId(promptId)) {
    return { deleted: local.deletePrompt(projectName, promptId) };
  }
  return cloud.deletePromptEntry(projectName, promptId);
}

// ---------------------------------------------------------------- credentials

type CredentialBody = {
  name: string;
  description?: string;
  projectTags?: string[];
  keyCount: number;
  cipher: CipherBlob;
};

export async function fetchCredentialSets(): Promise<CredentialSetRow[]> {
  return merged(
    () => cloud.fetchCredentialSets(),
    () => local.listCredentialSets()
  );
}

export async function fetchCredentialSet(credentialId: string): Promise<CredentialSetDetail> {
  if (isLocalId(credentialId)) {
    return local.getCredentialSet(credentialId);
  }
  return cloud.fetchCredentialSet(credentialId);
}

export async function createCredentialSet(body: CredentialBody): Promise<CredentialSetRow> {
  return route(
    async () => cloud.createCredentialSet({ ...body, cipher: await reencryptFor("cloud", body.cipher) }),
    async () => local.createCredentialSet({ ...body, cipher: await reencryptFor("local", body.cipher) })
  );
}

export async function updateCredentialSet(
  credentialId: string,
  body: CredentialBody
): Promise<CredentialSetRow> {
  if (isLocalId(credentialId)) {
    return local.updateCredentialSet(credentialId, {
      ...body,
      cipher: await reencryptFor("local", body.cipher),
    });
  }
  return cloud.updateCredentialSet(credentialId, {
    ...body,
    cipher: await reencryptFor("cloud", body.cipher),
  });
}

export async function setCredentialSetLocked(
  credentialId: string,
  locked: boolean
): Promise<CredentialSetRow> {
  if (isLocalId(credentialId)) {
    return local.setCredentialSetLocked(credentialId, locked);
  }
  return cloud.setCredentialSetLocked(credentialId, locked);
}

export async function deleteCredentialSet(credentialId: string): Promise<{ deleted: boolean }> {
  if (isLocalId(credentialId)) {
    return { deleted: local.deleteCredentialSet(credentialId) };
  }
  return cloud.deleteCredentialSet(credentialId);
}

// ---------------------------------------------------------------- AI Context

export async function fetchAiContexts(): Promise<AiContextRow[]> {
  return merged(
    () => cloud.fetchAiContexts(),
    () => local.listAiContexts()
  );
}

export async function fetchAiContext(id: string): Promise<AiContextRow> {
  if (isLocalId(id)) {
    return local.getAiContext(id);
  }
  return cloud.fetchAiContext(id);
}

export async function saveAiContext(body: { projectName: string; context: string }): Promise<AiContextRow> {
  return route(
    () => cloud.saveAiContext(body),
    () => local.saveAiContext(body)
  );
}

export async function updateAiContext(
  id: string,
  body: { projectName: string; context: string }
): Promise<AiContextRow> {
  if (isLocalId(id)) {
    return local.updateAiContext(id, body);
  }
  return cloud.updateAiContext(id, body);
}

export async function deleteAiContext(id: string): Promise<{ deleted: boolean }> {
  if (isLocalId(id)) {
    return { deleted: local.deleteAiContext(id) };
  }
  return cloud.deleteAiContext(id);
}
