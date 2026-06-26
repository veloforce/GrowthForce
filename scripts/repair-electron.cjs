#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const electronPackagePath = require.resolve("electron/package.json", { paths: [projectDir] });
const electronDir = path.dirname(electronPackagePath);
const electronPackage = require(electronPackagePath);
const cacheDir = path.join(projectDir, ".npm-cache");

const rebuild = childProcess.spawnSync(
  "npm",
  ["rebuild", "electron", "--foreground-scripts", "--cache", cacheDir],
  {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32"
  }
);

if (rebuild.error) {
  throw rebuild.error;
}

if (rebuild.status !== 0) {
  process.exit(rebuild.status || 1);
}

if (electronBinaryIsComplete()) {
  process.exit(0);
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  process.exit(1);
}

repairFromOfficialArtifact().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});

async function repairFromOfficialArtifact() {
  const { downloadArtifact } = require("@electron/get");
  const platform = process.env.npm_config_platform || process.platform;
  const arch = artifactArchitecture(platform);
  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    platform,
    arch,
    checksums: require(path.join(electronDir, "checksums.json"))
  });

  const distDir = path.join(electronDir, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(path.join(electronDir, "path.txt"), { force: true });
  fs.mkdirSync(distDir, { recursive: true });
  extractZip(zipPath, distDir);

  const extractedTypes = path.join(distDir, "electron.d.ts");
  if (fs.existsSync(extractedTypes)) {
    fs.renameSync(extractedTypes, path.join(electronDir, "electron.d.ts"));
  }

  fs.writeFileSync(path.join(electronDir, "path.txt"), platformExecutable(platform));
  if (!electronBinaryIsComplete()) {
    throw new Error("Electron artifact extraction completed without a usable executable.");
  }
}

function artifactArchitecture(platform) {
  if (process.env.npm_config_arch) {
    return process.env.npm_config_arch;
  }
  if (platform === "darwin" && process.platform === "darwin" && process.arch === "x64") {
    try {
      const translated = childProcess
        .execFileSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" })
        .trim();
      if (translated === "1") {
        return "arm64";
      }
    } catch {
      // Native Intel Macs do not expose sysctl.proc_translated.
    }
  }
  return process.arch;
}

function extractZip(zipPath, destination) {
  let command;
  let args;

  if (process.platform === "darwin") {
    command = "/usr/bin/ditto";
    args = ["-x", "-k", zipPath, destination];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      zipPath,
      destination
    ];
  } else {
    command = "unzip";
    args = ["-q", "-o", zipPath, "-d", destination];
  }

  const extraction = childProcess.spawnSync(command, args, {
    cwd: projectDir,
    stdio: "inherit",
    shell: false
  });
  if (extraction.error) {
    throw extraction.error;
  }
  if (extraction.status !== 0) {
    throw new Error(`Electron artifact extraction failed with status ${extraction.status}.`);
  }
}

function electronBinaryIsComplete() {
  const pathFile = path.join(electronDir, "path.txt");
  if (!fs.existsSync(pathFile)) {
    return false;
  }
  const relativeExecutable = fs.readFileSync(pathFile, "utf8").trim();
  return Boolean(
    relativeExecutable &&
    fs.existsSync(path.join(electronDir, "dist", relativeExecutable))
  );
}

function platformExecutable(platform) {
  switch (platform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}
