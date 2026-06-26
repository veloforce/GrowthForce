#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { installToolRuntime } = require("../dist/agent/tool-registry.js");

const rootDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const productName = packageJson.build?.productName || packageJson.name;
const expectedAppId = packageJson.build?.appId;
const expectedVersion = packageJson.version;
const options = parseArgs(process.argv.slice(2));

main();

function main() {
  if (options.platform === "darwin") {
    verifyMacPackage(options.arch);
    return;
  }
  if (options.platform === "win32") {
    verifyWindowsPackage(options.arch);
    return;
  }
  throw new Error(`Unsupported package verification target: ${options.platform}-${options.arch}`);
}

function verifyMacPackage(arch) {
  const appDir = path.join(rootDir, "release", arch === "arm64" ? "mac-arm64" : "mac", `${productName}.app`);
  assertDirectory(appDir, "macOS app bundle");

  const executable = path.join(appDir, "Contents", "MacOS", productName);
  assertFile(executable, "macOS app executable");
  const fileOutput = execFileSync("file", [executable], { encoding: "utf8" });
  const expectedArch = arch === "arm64" ? "arm64" : "x86_64";
  assert(fileOutput.includes(expectedArch), `Expected ${executable} to be ${expectedArch}, got: ${fileOutput.trim()}`);

  const plist = path.join(appDir, "Contents", "Info.plist");
  assertPlistValue(plist, "CFBundleIdentifier", expectedAppId);
  assertPlistValue(plist, "CFBundleIconFile", "icon.icns");
  assertPlistValue(plist, "CFBundleShortVersionString", expectedVersion);
  assertPlistValue(plist, "CFBundleVersion", expectedVersion);
  assertPlistValue(plist, "LSMinimumSystemVersion", "12.0");

  const resourcesDir = path.join(appDir, "Contents", "Resources");
  const bundleIcon = path.join(resourcesDir, "icon.icns");
  assertFile(bundleIcon, "macOS bundle icon");
  assertFilesEqual(bundleIcon, path.join(rootDir, "build", "icon.icns"), "macOS bundle icon");
  verifyCommonResources(resourcesDir);
  verifyAsar(path.join(resourcesDir, "app.asar"));

  const nativePackage = arch === "arm64" ? "claude-agent-sdk-darwin-arm64" : "claude-agent-sdk-darwin-x64";
  assertFile(path.join(resourcesDir, "app.asar.unpacked", "node_modules", "@anthropic-ai", nativePackage, "claude"), `${nativePackage} binary`);
  assertFile(path.join(resourcesDir, "resources", "connectors", "xhs", "bin", "darwin", arch, "xhs-cli", "xhs-cli"), "XHS darwin sidecar");
}

function verifyWindowsPackage(arch) {
  assert(arch === "x64", `Only win32-x64 is supported, got win32-${arch}`);
  const appDir = path.join(rootDir, "release", "win-unpacked");
  assertDirectory(appDir, "Windows unpacked app");
  assertFile(path.join(appDir, `${productName}.exe`), "Windows app executable");

  const resourcesDir = path.join(appDir, "resources");
  verifyCommonResources(resourcesDir);
  verifyAsar(path.join(resourcesDir, "app.asar"));
  assertFile(path.join(resourcesDir, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"), "claude-agent-sdk-win32-x64 binary");
  assertFile(path.join(resourcesDir, "resources", "connectors", "xhs", "bin", "win32", "x64", "xhs-cli", "xhs-cli.exe"), "XHS win32 sidecar");
}

function verifyCommonResources(resourcesDir) {
  assertDirectory(path.join(resourcesDir, "resources", "skills"), "bundled skills");
  assertFile(path.join(resourcesDir, "resources", "market", "skills.yml"), "bundled market skills");
  assertFile(path.join(resourcesDir, "resources", "prompts", "workbench-examples.json"), "bundled workbench prompts");
  verifyPackagedTools(path.join(resourcesDir, "resources", "tools"));
}

function verifyPackagedTools(toolsDir) {
  assertDirectory(toolsDir, "bundled tools");
  installToolRuntime();
  const allowedBuiltinModules = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const toolIds = fs.readdirSync(toolsDir)
    .filter((entry) => fs.existsSync(path.join(toolsDir, entry, "tool.json")))
    .sort();
  assert(toolIds.length > 0, `Expected bundled tools in ${toolsDir}`);

  for (const toolId of toolIds) {
    const toolDir = path.join(toolsDir, toolId);
    const metadataPath = path.join(toolDir, "tool.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    assert(metadata.name === toolId, `Expected ${metadataPath} name to equal ${toolId}`);
    if (toolId === "image") {
      const fontsDir = path.join(toolDir, "assets", "fonts");
      assertFile(path.join(fontsDir, "JiangChengZhiYinTi-600W.ttf"), "bundled image title font");
      assertFile(path.join(fontsDir, "JiangChengZhiYinTi-400W.ttf"), "bundled image content font");
      assertFile(path.join(fontsDir, "OFL-1.1.txt"), "bundled image font license");
    }
    const entry = path.resolve(toolDir, metadata.entry);
    assertFile(entry, `bundled tool ${toolId} entry`);
    const source = fs.readFileSync(entry, "utf8");
    for (const match of source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
      assert(match[2].startsWith(".") || allowedBuiltinModules.has(match[2]), `Tool ${toolId} retains forbidden external dependency ${match[2]}`);
    }
    delete require.cache[entry];
    const loaded = require(entry);
    assert(typeof loaded.createServer === "function", `Expected bundled tool ${toolId} to export createServer()`);
    loaded.createServer();
  }
}

function verifyAsar(asarPath) {
  assertFile(asarPath, "app.asar");
  const listedEntries = asar.listPackage(asarPath);
  const entries = new Set(listedEntries.map(normalizeAsarEntry));
  for (const entry of ["dist/main/main.js", "dist/preload/preload.js", "dist/renderer/index.html"]) {
    assert(entries.has(entry), `Missing ${entry} in ${asarPath}. Dist entries: ${summarizeEntries(entries, "dist/")}`);
  }
  const bundledPackage = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  assert(bundledPackage.version === expectedVersion, `Expected asar package version ${expectedVersion}, got ${bundledPackage.version}`);
}

function normalizeAsarEntry(entry) {
  return entry.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

function summarizeEntries(entries, prefix) {
  const matches = Array.from(entries).filter((entry) => entry.startsWith(prefix)).slice(0, 20);
  return matches.length > 0 ? matches.join(", ") : "<none>";
}

function assertPlistValue(plist, key, expected) {
  assertFile(plist, "Info.plist");
  const value = execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
  assert(value === expected, `Expected Info.plist ${key}=${expected}, got ${value}`);
}

function parseArgs(args) {
  const parsed = {
    platform: process.platform,
    arch: process.arch
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      parsed.platform = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      parsed.platform = arg.slice("--platform=".length);
      continue;
    }
    if (arg === "--arch") {
      parsed.arch = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--arch=")) {
      parsed.arch = arg.slice("--arch=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readArgValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

function assertDirectory(dir, label) {
  assert(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `Missing ${label}: ${dir}`);
}

function assertFile(file, label) {
  assert(fs.existsSync(file) && fs.statSync(file).isFile(), `Missing ${label}: ${file}`);
}

function assertFilesEqual(actual, expected, label) {
  assertFile(actual, label);
  assertFile(expected, `${label} source`);
  const actualBytes = fs.readFileSync(actual);
  const expectedBytes = fs.readFileSync(expected);
  assert(actualBytes.equals(expectedBytes), `Expected ${label} ${actual} to match ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
