// Minimal stand-in for the `vscode` module, enough for the non-UI modules.
const cfg = (globalThis.__anamnesisConfig = globalThis.__anamnesisConfig || {
  serverUrl: "",
  clientId: "",
  secretKey: "",
  defaultTag: "default",
});

class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose: () => {} }; }; }
  fire(v) { for (const fn of this.listeners) fn(v); }
  dispose() { this.listeners = []; }
}

module.exports = {
  EventEmitter,
  workspace: {
    getConfiguration: () => ({ get: (k) => cfg[k] }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {},
  env: { appName: "Visual Studio Code", uriScheme: "vscode", appRoot: "/Applications/Visual Studio Code.app" },
};
