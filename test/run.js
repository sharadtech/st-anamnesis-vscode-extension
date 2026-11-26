// Bundles each test/*.test.ts with a `vscode` stub and runs it with node:test
// in a throwaway HOME, so nothing touches the real ~/.anamnesis.
const { buildSync } = require("esbuild");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "anamnesis-test-"));
const only = process.argv[2];
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.ts") && (!only || f.includes(only)));
let failed = false;
for (const file of files) {
  const outfile = path.join(out, file.replace(/\.ts$/, ".js"));
  buildSync({
    entryPoints: [path.join(__dirname, file)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile,
    alias: { vscode: path.join(__dirname, "vscode-stub.js") },
    logLevel: "error",
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "anamnesis-home-"));
  const res = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-timeout=30000", outfile], {
    stdio: "inherit",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: root,
  });
  if (res.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
