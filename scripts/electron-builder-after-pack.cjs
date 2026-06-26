const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");

const claudeBinaryPackages = new Set([
  "claude-agent-sdk-darwin-x64",
  "claude-agent-sdk-darwin-arm64",
  "claude-agent-sdk-win32-x64"
]);

module.exports = async function afterPack(context) {
  ensureMacBundleIcon(context);

  const targetPackage = getTargetClaudeBinaryPackage(context);

  const anthropicDir = path.join(getUnpackedNodeModulesDir(context), "@anthropic-ai");
  if (targetPackage && fs.existsSync(anthropicDir)) {
    for (const entry of fs.readdirSync(anthropicDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!claudeBinaryPackages.has(entry.name)) continue;
      if (entry.name === targetPackage) continue;
      fs.rmSync(path.join(anthropicDir, entry.name), { recursive: true, force: true });
    }
  }

  assertTargetXhsSidecar(context);
};

function ensureMacBundleIcon(context) {
  if (context.electronPlatformName !== "darwin") return;

  const resourcesDir = getPackagedResourcesDir(context);
  const appDir = path.dirname(resourcesDir);
  const plistPath = path.join(appDir, "Info.plist");
  const sourceIconPath = path.join(__dirname, "..", "build", "icon.icns");
  const targetIconPath = path.join(resourcesDir, "icon.icns");

  if (!fs.existsSync(sourceIconPath)) {
    throw new Error(`Missing macOS bundle icon source at ${sourceIconPath}. Run npm run generate:icons before electron-builder.`);
  }
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Missing macOS Info.plist at ${plistPath}`);
  }

  fs.copyFileSync(sourceIconPath, targetIconPath);
  const plist = fs.readFileSync(plistPath, "utf8");
  const nextPlist = setPlistStringValue(plist, "CFBundleIconFile", "icon.icns");
  fs.writeFileSync(plistPath, nextPlist, "utf8");
}

function setPlistStringValue(plist, key, value) {
  const keyPattern = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<string>)([^<]*)(</string>)`);
  if (keyPattern.test(plist)) {
    return plist.replace(keyPattern, `$1${value}$3`);
  }

  const dictEnd = plist.lastIndexOf("</dict>");
  if (dictEnd < 0) {
    throw new Error(`Cannot update Info.plist because </dict> was not found for ${key}`);
  }
  return `${plist.slice(0, dictEnd)}\t<key>${key}</key>\n\t<string>${value}</string>\n${plist.slice(dictEnd)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUnpackedNodeModulesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app.asar.unpacked", "node_modules");
  }
  return path.join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules");
}

function getTargetClaudeBinaryPackage(context) {
  const arch = Arch[context.arch];
  if (context.electronPlatformName === "darwin" && arch === "x64") return "claude-agent-sdk-darwin-x64";
  if (context.electronPlatformName === "darwin" && arch === "arm64") return "claude-agent-sdk-darwin-arm64";
  if (context.electronPlatformName === "win32" && arch === "x64") return "claude-agent-sdk-win32-x64";
  return null;
}

function assertTargetXhsSidecar(context) {
  const target = getTargetXhsSidecar(context);
  if (!target) return;
  const resourcesDir = getPackagedResourcesDir(context);
  const binRoot = path.join(resourcesDir, "resources", "connectors", "xhs", "bin");
  const targetPath = path.join(binRoot, target.platform, target.arch, "xhs-cli", target.binary);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing XHS sidecar onedir executable ${target.binary} at ${targetPath}. Run scripts/build-xhs-sidecar.cjs before electron-builder.`);
  }

  for (const platform of fs.existsSync(binRoot) ? fs.readdirSync(binRoot) : []) {
    const platformDir = path.join(binRoot, platform);
    if (!fs.statSync(platformDir).isDirectory()) continue;
    for (const arch of fs.readdirSync(platformDir)) {
      const archDir = path.join(platformDir, arch);
      if (!fs.statSync(archDir).isDirectory()) continue;
      if (platform === target.platform && arch === target.arch) continue;
      fs.rmSync(archDir, { recursive: true, force: true });
    }
  }
}

function getPackagedResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function getTargetXhsSidecar(context) {
  const arch = Arch[context.arch];
  if (context.electronPlatformName === "darwin" && arch === "x64") return { platform: "darwin", arch: "x64", binary: "xhs-cli" };
  if (context.electronPlatformName === "darwin" && arch === "arm64") return { platform: "darwin", arch: "arm64", binary: "xhs-cli" };
  if (context.electronPlatformName === "win32" && arch === "x64") return { platform: "win32", arch: "x64", binary: "xhs-cli.exe" };
  return null;
}
