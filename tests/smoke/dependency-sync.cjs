const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "../..");
const syncScript = path.join(rootDir, "scripts", "sync-dependencies.sh");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-dependency-sync-"));
const projectDir = path.join(tempDir, "project");
const localDependencyDir = path.join(tempDir, "local-dependency");
const electronProjectDir = path.join(tempDir, "electron-project");
const electronVersion = require(path.join(rootDir, "node_modules", "electron", "package.json")).version;

try {
  fs.mkdirSync(projectDir, { recursive: true });
  writeJson(path.join(projectDir, "package.json"), {
    name: "dependency-sync-test",
    version: "1.0.0",
    private: true
  });
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"], projectDir);

  const firstSync = run("bash", [syncScript, projectDir], rootDir);
  assert.match(firstSync.stdout, /Synchronizing npm dependencies/);
  assert.ok(fs.existsSync(path.join(projectDir, "node_modules")));
  assert.equal(readMarker(projectDir), hashLockfile(projectDir));

  const unchangedSync = run("bash", [syncScript, projectDir], rootDir);
  assert.match(unchangedSync.stdout, /npm dependencies are up to date/);

  fs.mkdirSync(localDependencyDir, { recursive: true });
  writeJson(path.join(localDependencyDir, "package.json"), {
    name: "dependency-sync-local",
    version: "1.0.0",
    main: "index.js"
  });
  fs.writeFileSync(path.join(localDependencyDir, "index.js"), "module.exports = 42;\n");
  writeJson(path.join(projectDir, "package.json"), {
    name: "dependency-sync-test",
    version: "1.0.0",
    private: true,
    dependencies: {
      "dependency-sync-local": `file:${localDependencyDir}`
    }
  });
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"], projectDir);

  const changedSync = run("bash", [syncScript, projectDir], rootDir);
  assert.match(changedSync.stdout, /Synchronizing npm dependencies/);
  assert.equal(
    require(path.join(projectDir, "node_modules", "dependency-sync-local")),
    42
  );
  assert.equal(readMarker(projectDir), hashLockfile(projectDir));

  const previousMarker = readMarker(projectDir);
  fs.writeFileSync(path.join(projectDir, "package.json"), "{ invalid json\n");
  writeJson(path.join(projectDir, "package-lock.json"), {
    name: "dependency-sync-test",
    version: "2.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "dependency-sync-test",
        version: "2.0.0"
      }
    }
  });

  const failedSync = spawnSync("bash", [syncScript, projectDir], {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert.notEqual(failedSync.status, 0, "Expected dependency installation failure");
  assert.equal(readMarker(projectDir), previousMarker);

  fs.mkdirSync(electronProjectDir, { recursive: true });
  writeJson(path.join(electronProjectDir, "package.json"), {
    name: "dependency-sync-electron-test",
    version: "1.0.0",
    private: true,
    devDependencies: {
      electron: electronVersion
    }
  });
  run(
    "npm",
    ["install", "--ignore-scripts", "--cache", path.join(rootDir, ".npm-cache")],
    electronProjectDir
  );
  assertElectronIncomplete(electronProjectDir);

  const electronRepair = run("bash", [syncScript, electronProjectDir], rootDir);
  assert.match(electronRepair.stdout, /Electron binary is incomplete/);
  assert.match(electronRepair.stdout, /Electron binary repaired/);
  assertElectronComplete(electronProjectDir);

  fs.rmSync(path.join(electronProjectDir, "node_modules", "electron", "dist"), {
    recursive: true,
    force: true
  });
  fs.rmSync(path.join(electronProjectDir, "node_modules", "electron", "path.txt"), {
    force: true
  });
  assertElectronIncomplete(electronProjectDir);

  const skippedRepair = spawnSync("bash", [syncScript, electronProjectDir], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1"
    }
  });
  assert.notEqual(skippedRepair.status, 0, "Expected incomplete Electron repair to fail");
  assert.match(`${skippedRepair.stdout}\n${skippedRepair.stderr}`, /Electron binary is still incomplete/);

  for (const caller of ["dev.sh", "build.sh"]) {
    const source = fs.readFileSync(path.join(rootDir, "scripts", caller), "utf8");
    assert.match(source, /sync-dependencies\.sh/);
  }

  console.log("Dependency synchronization smoke test passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with status ${result.status}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashLockfile(directory) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(directory, "package-lock.json")))
    .digest("hex");
}

function readMarker(directory) {
  return fs
    .readFileSync(path.join(directory, "node_modules", ".agentstudio-package-lock.sha256"), "utf8")
    .trim();
}

function electronExecutable(directory) {
  const electronDir = path.join(directory, "node_modules", "electron");
  const relativePath = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
  return path.join(electronDir, "dist", relativePath);
}

function assertElectronComplete(directory) {
  assert.ok(
    fs.existsSync(electronExecutable(directory)),
    "Expected Electron executable to exist"
  );
}

function assertElectronIncomplete(directory) {
  assert.throws(
    () => electronExecutable(directory),
    /ENOENT/,
    "Expected Electron path metadata to be missing"
  );
}
