#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const engineDir = path.join(rootDir, "resources", "connectors", "xhs", "engine");
const scriptsDir = path.join(engineDir, "scripts");
const target = parseTarget(process.argv.slice(2));
const buildRoot = path.join(rootDir, ".build", "xhs-sidecar", `${target.platform}-${target.arch}`);
const venvDir = path.join(buildRoot, "venv");
const outDir = path.join(rootDir, "resources", "connectors", "xhs", "bin", target.platform, target.arch);
const binaryName = target.platform === "win32" ? "xhs-cli.exe" : "xhs-cli";
const sidecarDir = path.join(outDir, "xhs-cli");
let python;

main();

function main() {
  assertEngine();
  assertNativeTarget();
  python = selectPython();
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  ensureVenv();
  installDependencies();
  buildBinary();
  const binaryPath = getSidecarExecutablePath();
  fs.accessSync(binaryPath, fs.constants.X_OK);
  console.log(`[xhs-sidecar] built ${binaryPath}`);
}

function assertEngine() {
  const cli = path.join(scriptsDir, "cli.py");
  if (!fs.existsSync(cli)) {
    throw new Error(`XHS engine CLI not found: ${cli}`);
  }
}

function assertNativeTarget() {
  if (target.platform === process.platform && target.arch === process.arch) return;
  throw new Error(
    [
      `XHS sidecar must be built on the target platform and architecture.`,
      `Requested ${target.platform}-${target.arch}, but current host is ${process.platform}-${process.arch}.`,
      `Run this command on a matching runner or machine before electron-builder.`
    ].join(" ")
  );
}

function selectPython() {
  const explicit = getExplicitPythonCandidate();
  if (explicit) {
    const check = checkPython(explicit);
    if (check.ok) {
      console.log(`[xhs-sidecar] using ${formatCommand(explicit)} (${check.version}) from ${explicit.source}`);
      return explicit;
    }
    throw new Error(
      `Python >= 3.11 is required to build XHS sidecar, but ${explicit.source}=${explicit.label} is ${check.detail}.`
    );
  }

  const attempts = [];
  for (const candidate of getPythonCandidates()) {
    const check = checkPython(candidate);
    attempts.push(`${candidate.label}: ${check.detail}`);
    if (check.ok) {
      console.log(`[xhs-sidecar] using ${formatCommand(candidate)} (${check.version})`);
      return candidate;
    }
  }

  throw new Error(
    [
      "Python >= 3.11 is required to build XHS sidecar, but no compatible interpreter was found.",
      "Tried:",
      ...attempts.map((attempt) => `- ${attempt}`),
      "Install Python 3.11+ or set PYTHON=/path/to/python3.11."
    ].join("\n")
  );
}

function getExplicitPythonCandidate() {
  if (process.env.PYTHON) {
    return createPythonCandidate(process.env.PYTHON, [], "PYTHON");
  }
  if (process.env.AGENTSTUDIO_PYTHON) {
    return createPythonCandidate(process.env.AGENTSTUDIO_PYTHON, [], "AGENTSTUDIO_PYTHON");
  }
  return null;
}

function getPythonCandidates() {
  const candidates = [];
  const add = (command, args = []) => candidates.push(createPythonCandidate(command, args, "auto"));

  if (process.platform === "win32") {
    add("py", ["-3.11"]);
    add("py", ["-3.12"]);
    add("py", ["-3.13"]);
    add("python3.11");
    add("python3.12");
    add("python3.13");
    add("python");
  } else {
    add("python3.11");
    add("python3.12");
    add("python3.13");
    if (process.platform === "darwin") {
      add("/opt/homebrew/opt/python@3.11/bin/python3.11");
      add("/opt/homebrew/opt/python@3.12/bin/python3.12");
      add("/opt/homebrew/opt/python@3.13/bin/python3.13");
      add("/opt/homebrew/bin/python3.11");
      add("/opt/homebrew/bin/python3.12");
      add("/opt/homebrew/bin/python3.13");
      add("/usr/local/opt/python@3.11/bin/python3.11");
      add("/usr/local/opt/python@3.12/bin/python3.12");
      add("/usr/local/opt/python@3.13/bin/python3.13");
      add("/usr/local/bin/python3.11");
      add("/usr/local/bin/python3.12");
      add("/usr/local/bin/python3.13");
    }
    add("python3");
    add("python");
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = formatCommand(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createPythonCandidate(command, args, source) {
  return {
    command,
    args,
    source,
    label: formatCommand({ command, args })
  };
}

function checkPython(candidate) {
  const result = runPythonCandidate(candidate, [
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}'); raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
  ], { allowFailure: true, quiet: true });
  const version = (result.stdout || "").trim();
  const detail = version || (result.stderr || "").trim() || result.error?.message || "unknown";
  return {
    ok: result.status === 0,
    version,
    detail
  };
}

function ensureVenv() {
  const venvPython = getVenvPython();
  if (fs.existsSync(venvPython)) {
    const check = checkPython(createPythonCandidate(venvPython, [], "venv"));
    if (check.ok) return;
    console.log(`[xhs-sidecar] removing incompatible venv Python at ${venvPython} (${check.detail})`);
    fs.rmSync(venvDir, { recursive: true, force: true });
  }
  runPython(["-m", "venv", venvDir]);
}

function installDependencies() {
  const venvPython = getVenvPython();
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(venvPython, [
    "-m",
    "pip",
    "install",
    "pyinstaller>=6.0",
    "requests>=2.28.0",
    "websockets>=12.0",
    "python-socks>=2.8.1"
  ]);
}

function buildBinary() {
  const venvPython = getVenvPython();
  fs.rmSync(sidecarDir, { recursive: true, force: true });
  run(venvPython, [
    "-m",
    "PyInstaller",
    "--clean",
    "--noconfirm",
    "--onedir",
    "--name",
    "xhs-cli",
    "--distpath",
    outDir,
    "--workpath",
    path.join(buildRoot, "pyinstaller-work"),
    "--specpath",
    buildRoot,
    "--paths",
    scriptsDir,
    "--collect-submodules",
    "xhs",
    "--hidden-import",
    "image_downloader",
    "--hidden-import",
    "title_utils",
    path.join(scriptsDir, "cli.py")
  ], { cwd: engineDir });
}

function getSidecarExecutablePath() {
  return path.join(sidecarDir, binaryName);
}

function getVenvPython() {
  return process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
}

function parseTarget(args) {
  const target = {
    platform: process.platform,
    arch: process.arch
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") {
      target.platform = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      target.platform = arg.slice("--platform=".length);
      continue;
    }
    if (arg === "--arch") {
      target.arch = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--arch=")) {
      target.arch = arg.slice("--arch=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  assertSupportedTarget(target);
  return target;
}

function readOptionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function assertSupportedTarget(target) {
  const supported = new Set(["darwin-x64", "darwin-arm64", "win32-x64"]);
  const key = `${target.platform}-${target.arch}`;
  if (!supported.has(key)) {
    throw new Error(`Unsupported XHS sidecar target: ${key}. Supported targets: ${Array.from(supported).join(", ")}`);
  }
}

function run(command, args, options = {}) {
  if (!options.quiet) {
    console.log(`[xhs-sidecar] ${formatCommand({ command, args })}`);
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    stdio: options.allowFailure ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (!options.allowFailure && result.status !== 0) {
    const detail = result.error?.message ? ` (${result.error.message})` : "";
    throw new Error(`Command failed: ${formatCommand({ command, args })}${detail}`);
  }
  return result;
}

function runPython(args, options = {}) {
  return runPythonCandidate(python, args, options);
}

function runPythonCandidate(candidate, args, options = {}) {
  return run(candidate.command, [...candidate.args, ...args], options);
}

function formatCommand(candidate) {
  return [candidate.command, ...candidate.args].join(" ");
}
