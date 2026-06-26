const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const esbuild = require("esbuild");

const rootDir = path.resolve(__dirname, "..");
const toolsDir = path.join(rootDir, "resources", "tools");
const allowedExternalModules = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);

if (!fs.existsSync(toolsDir)) {
  process.exit(0);
}

const tools = fs.readdirSync(toolsDir)
  .filter((entry) => fs.existsSync(path.join(toolsDir, entry, "src", "index.ts")))
  .sort();

for (const toolName of tools) {
  const toolDir = path.join(toolsDir, toolName);
  const entryPoint = path.join(toolDir, "src", "index.ts");
  const outfile = path.join(toolDir, "dist", "index.js");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent"
  });

  assertAllowedExternalImports(toolName, result.metafile);
  assertNoForbiddenBareRequires(toolName, outfile);
  console.log(`Bundled tool "${toolName}" -> ${path.relative(rootDir, outfile)}`);
}

function assertAllowedExternalImports(toolName, metafile) {
  const forbidden = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !allowedExternalModules.has(imported.path)) {
        forbidden.add(imported.path);
      }
    }
  }
  if (forbidden.size > 0) {
    throw new Error(`Tool "${toolName}" retains external dependencies: ${Array.from(forbidden).sort().join(", ")}`);
  }
}

function assertNoForbiddenBareRequires(toolName, outfile) {
  const source = fs.readFileSync(outfile, "utf8");
  const forbidden = new Set();
  for (const match of source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
    const requested = match[2];
    if (!requested.startsWith(".") && !path.isAbsolute(requested) && !allowedExternalModules.has(requested)) {
      forbidden.add(requested);
    }
  }
  if (forbidden.size > 0) {
    throw new Error(`Tool "${toolName}" bundle contains forbidden bare require calls: ${Array.from(forbidden).sort().join(", ")}`);
  }
}
