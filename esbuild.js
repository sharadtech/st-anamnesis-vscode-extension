const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

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
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionOptions);
    await ctx.watch();
    console.log("[esbuild] watching src/extension.ts");
  } else {
    await esbuild.build(extensionOptions);
    console.log("[esbuild] built dist/extension.js");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
