import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AuthUser, config, fetchAuthUser, isNetworkError } from "./cloudApi";

/**
 * Decides whether the extension talks to Anamnesis Cloud or works from the
 * local store (~/.anamnesis/local). Local mode is used when the Client Id /
 * Secret Key are missing, when the server cannot be reached (VPN, offline),
 * or when the server rejects the credentials.
 */
export type Mode = "cloud" | "local";
export type LocalReason = "no-credentials" | "unreachable" | "auth-failed";

export interface ModeState {
  mode: Mode;
  /** Set when mode is "local". */
  reason?: LocalReason;
  /** Human-readable detail of the last probe. */
  detail: string;
  /** Signed-in user when in cloud mode (or cached from the last success). */
  user?: AuthUser;
}

const RETRY_INTERVAL_MS = 2 * 60_000;
const AUTH_CACHE_FILE = path.join(os.homedir(), ".anamnesis", "auth-user.json");

let state: ModeState = { mode: "local", reason: "no-credentials", detail: "Not checked yet" };
let probing: Promise<ModeState> | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let initialised = false;
let firstProbe: Promise<ModeState> | undefined;
const emitter = new vscode.EventEmitter<ModeState>();

/** Fires whenever mode or reason changes. */
export const onDidChangeMode = emitter.event;

/** Resolves once the first probe after activation has finished. */
export async function modeReady(): Promise<ModeState> {
  if (firstProbe) {
    await firstProbe;
  }
  return state;
}

export function getModeState(): ModeState {
  return state;
}

export function isLocalMode(): boolean {
  return state.mode === "local";
}

export function describeReason(reason?: LocalReason): string {
  switch (reason) {
    case "no-credentials":
      return "Client Id / Secret Key not configured";
    case "unreachable":
      return "Anamnesis Cloud is unreachable";
    case "auth-failed":
      return "Anamnesis Cloud rejected the Client Id / Secret Key";
    default:
      return "";
  }
}

function setState(next: ModeState): void {
  const changed = next.mode !== state.mode || next.reason !== state.reason;
  state = next;
  scheduleRetry();
  if (changed) {
    emitter.fire(state);
  }
}

function scheduleRetry(): void {
  const wantRetry = state.mode === "local" && state.reason !== "no-credentials";
  if (wantRetry && !retryTimer) {
    retryTimer = setInterval(() => void probe(), RETRY_INTERVAL_MS);
    retryTimer.unref?.();
  } else if (!wantRetry && retryTimer) {
    clearInterval(retryTimer);
    retryTimer = undefined;
  }
}

/** Cached AuthUser keyed by Client Id, so credential crypto works offline. */
export function cachedAuthUser(): AuthUser | undefined {
  const { clientId } = config();
  if (state.user && clientId) {
    return state.user;
  }
  try {
    const cached = JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, "utf-8"));
    if (cached && cached.clientId === clientId && cached.user?.userId) {
      return cached.user as AuthUser;
    }
  } catch {
    // no cache
  }
  return undefined;
}

function cacheAuthUser(clientId: string, user: AuthUser): void {
  try {
    fs.mkdirSync(path.dirname(AUTH_CACHE_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify({ clientId, user }, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best effort
  }
}

/** Check connectivity and credentials now. Concurrent callers share one probe. */
export function probe(): Promise<ModeState> {
  if (!probing) {
    probing = doProbe().finally(() => {
      probing = undefined;
    });
  }
  return probing;
}

async function doProbe(): Promise<ModeState> {
  const { serverUrl, clientId, secretKey } = config();
  if (!serverUrl || !clientId || !secretKey) {
    setState({ mode: "local", reason: "no-credentials", detail: describeReason("no-credentials") });
    return state;
  }
  try {
    const user = await fetchAuthUser();
    cacheAuthUser(clientId, user);
    setState({ mode: "cloud", detail: `Connected to ${serverUrl}`, user });
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : String(err);
    if (isNetworkError(err) || (status !== undefined && status >= 500)) {
      setState({ mode: "local", reason: "unreachable", detail: message, user: cachedAuthUser() });
    } else {
      setState({ mode: "local", reason: "auth-failed", detail: message });
    }
  }
  return state;
}

/** Called by the API router when a cloud request fails with a network error. */
export function markOffline(detail: string): void {
  if (state.mode === "cloud") {
    setState({ mode: "local", reason: "unreachable", detail, user: state.user });
  }
}

/** Start probing on activation and whenever anamnesis.* settings change. */
export function initModeMonitor(context: vscode.ExtensionContext): Promise<ModeState> {
  if (!initialised) {
    initialised = true;
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("anamnesis.serverUrl") ||
          e.affectsConfiguration("anamnesis.clientId") ||
          e.affectsConfiguration("anamnesis.secretKey")
        ) {
          void probe();
        }
      }),
      { dispose: () => retryTimer && clearInterval(retryTimer) },
      emitter
    );
  }
  firstProbe = probe();
  return firstProbe;
}
