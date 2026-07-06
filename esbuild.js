const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

function copyWasmAssets() {
  const outDir = path.join(__dirname, "dist", "wasm");
  fs.mkdirSync(outDir, { recursive: true });

  const webTreeSitterWasm = path.join(
    __dirname,
    "node_modules",
    "web-tree-sitter",
    "tree-sitter.wasm"
  );
  if (fs.existsSync(webTreeSitterWasm)) {
    fs.copyFileSync(webTreeSitterWasm, path.join(outDir, "tree-sitter.wasm"));
  }

  const wasmsDir = path.join(__dirname, "node_modules", "tree-sitter-wasms", "out");
  const grammarFiles = [
    "tree-sitter-java.wasm",
    "tree-sitter-javascript.wasm",
    "tree-sitter-typescript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-html.wasm",
  ];
  for (const file of grammarFiles) {
    const src = path.join(wasmsDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, file));
    }
  }
  console.log("[esbuild] copied tree-sitter WASM assets to dist/wasm/");
}

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // web-tree-sitter's Node binding calls createRequire(import.meta.url).
  // In a CJS bundle import.meta.url is undefined, which throws
  // "The argument 'filename' must be a file URL ... Received undefined".
  // Point it at the bundled file so createRequire works.
  define: {
    "import.meta.url": "__anamnesisImportMetaUrl",
  },
  banner: {
    js: "const __anamnesisImportMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionOptions);
    await ctx.watch();
    copyWasmAssets();
    console.log("[esbuild] watching src/extension.ts");
  } else {
    await esbuild.build(extensionOptions);
    copyWasmAssets();
    console.log("[esbuild] built dist/extension.js");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
