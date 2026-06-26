const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const toolsDir = path.join(rootDir, "resources", "tools");
const tscBin = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

if (!fs.existsSync(toolsDir)) {
  process.exit(0);
}

if (!fs.existsSync(tscBin)) {
  console.error(`TypeScript compiler not found at ${path.relative(rootDir, tscBin)}. Run npm install first.`);
  process.exit(1);
}

const tools = fs.readdirSync(toolsDir)
  .filter((entry) => fs.existsSync(path.join(toolsDir, entry, "src")))
  .sort();

console.log(`Typechecking ${tools.length} tool(s) in ${path.relative(rootDir, toolsDir) || toolsDir}`);

for (const toolName of tools) {
  const toolDir = path.join(toolsDir, toolName);
  const sourceFiles = listTypescriptFiles(path.join(toolDir, "src"));
  if (sourceFiles.length === 0) continue;

  console.log(`- ${toolName}: ${sourceFiles.length} TypeScript file(s)`);
  const result = spawnSync(
    process.execPath,
    [
      tscBin,
      ...sourceFiles,
      "--ignoreConfig",
      "--target",
      "ES2022",
      "--lib",
      "ES2022,DOM",
      "--module",
      "CommonJS",
      "--moduleResolution",
      "Node",
      "--ignoreDeprecations",
      "6.0",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      "--forceConsistentCasingInFileNames",
      "--resolveJsonModule",
      "--types",
      "node",
      "--noEmit"
    ],
    {
      cwd: rootDir,
      stdio: "inherit"
    }
  );

  if (result.error) {
    console.error(`Failed to start TypeScript for tool "${toolName}": ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`TypeScript failed for tool "${toolName}" with exit code ${result.status ?? "unknown"}.`);
    process.exit(result.status ?? 1);
  }
}

function listTypescriptFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTypescriptFiles(entryPath));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}
