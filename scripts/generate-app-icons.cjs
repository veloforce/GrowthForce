#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PNG } = require("pngjs");

const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "docs", "logo.png");
const buildDir = path.join(repoRoot, "build");
const iconsetDir = path.join(buildDir, "icon.iconset");
const resourceIconDir = path.join(repoRoot, "resources", "icons");
const rendererLogoPath = path.join(repoRoot, "src", "renderer", "src", "assets", "logo.png");

const logoSafeZoneMultiplier = 1.45;
const appTileScale = 824 / 1024;
const fallbackCrop = { x: 45, y: 50, size: 1446 };
const outputPngSize = 400;
const iconsetEntries = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_64x64.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
const icoSizes = [16, 32, 48, 64, 128, 256];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function writePng(filePath, png) {
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [command] : ["-c", `command -v ${command}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function detectCrop(source) {
  const logoCrop = detectLogoCrop(source);
  if (logoCrop) return logoCrop;

  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const i = (y * source.width + x) * 4;
      const r = source.data[i];
      const g = source.data[i + 1];
      const b = source.data[i + 2];

      // The white card has a slight blue tint, unlike the baked checkerboard.
      if (r > 230 && g > 230 && b > 230 && b - r >= 3 && b - g >= 2) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }

  if (count < 10000 || maxX <= minX || maxY <= minY) return fallbackCrop;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const size = Math.min(source.width, source.height, Math.max(width, height) + 8);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const x = Math.max(0, Math.min(source.width - size, Math.round(centerX - size / 2)));
  const y = Math.max(0, Math.min(source.height - size, Math.round(centerY - size / 2)));
  return { x, y, size };
}

function detectLogoCrop(source) {
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const i = (y * source.width + x) * 4;
      const r = source.data[i];
      const g = source.data[i + 1];
      const b = source.data[i + 2];
      const a = source.data[i + 3];

      if (a > 5 && b > 120 && b - r > 35 && b - g > 20) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }

  if (count < 10000 || maxX <= minX || maxY <= minY) return null;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const size = Math.min(source.width, source.height, Math.round(Math.max(width, height) * logoSafeZoneMultiplier));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const x = Math.max(0, Math.min(source.width - size, Math.round(centerX - size / 2)));
  const y = Math.max(0, Math.min(source.height - size, Math.round(centerY - size / 2)));
  return { x, y, size };
}

function sampleBilinear(source, x, y) {
  const x0 = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(source.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(source.height - 1, y0 + 1));
  const tx = x - x0;
  const ty = y - y0;

  const c00 = (y0 * source.width + x0) * 4;
  const c10 = (y0 * source.width + x1) * 4;
  const c01 = (y1 * source.width + x0) * 4;
  const c11 = (y1 * source.width + x1) * 4;
  const out = [0, 0, 0, 255];

  for (let channel = 0; channel < 4; channel += 1) {
    const top = source.data[c00 + channel] * (1 - tx) + source.data[c10 + channel] * tx;
    const bottom = source.data[c01 + channel] * (1 - tx) + source.data[c11 + channel] * tx;
    out[channel] = Math.round(top * (1 - ty) + bottom * ty);
  }

  return out;
}

function roundedRectAlpha(x, y, size) {
  const radius = size * 0.225;
  const aa = Math.max(1, size / 256);
  const px = x + 0.5;
  const py = y + 0.5;
  const cx = Math.max(radius, Math.min(size - radius, px));
  const cy = Math.max(radius, Math.min(size - radius, py));
  const distance = Math.hypot(px - cx, py - cy) - radius;

  if (distance <= -aa) return 255;
  if (distance >= aa) return 0;
  return Math.round(255 * (1 - (distance + aa) / (2 * aa)));
}

function renderIcon(source, crop, size) {
  const out = new PNG({ width: size, height: size });
  const tileSize = Math.max(1, Math.round(size * appTileScale));
  const tileOffset = Math.floor((size - tileSize) / 2);
  const scale = crop.size / tileSize;

  for (let y = 0; y < tileSize; y += 1) {
    for (let x = 0; x < tileSize; x += 1) {
      const srcX = crop.x + (x + 0.5) * scale - 0.5;
      const srcY = crop.y + (y + 0.5) * scale - 0.5;
      const [r, g, b, a] = sampleBilinear(source, srcX, srcY);
      const mask = roundedRectAlpha(x, y, tileSize);
      const outputX = tileOffset + x;
      const outputY = tileOffset + y;
      const i = (outputY * size + outputX) * 4;

      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = Math.round((a * mask) / 255);
    }
  }

  return out;
}

function makeIco(pngBuffers) {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + pngBuffers.length * entrySize;
  const totalSize = directorySize + pngBuffers.reduce((sum, item) => sum + item.buffer.length, 0);
  const ico = Buffer.alloc(totalSize);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(pngBuffers.length, 4);

  let imageOffset = directorySize;
  pngBuffers.forEach((item, index) => {
    const entryOffset = headerSize + index * entrySize;
    ico.writeUInt8(item.size >= 256 ? 0 : item.size, entryOffset);
    ico.writeUInt8(item.size >= 256 ? 0 : item.size, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2);
    ico.writeUInt8(0, entryOffset + 3);
    ico.writeUInt16LE(1, entryOffset + 4);
    ico.writeUInt16LE(32, entryOffset + 6);
    ico.writeUInt32LE(item.buffer.length, entryOffset + 8);
    ico.writeUInt32LE(imageOffset, entryOffset + 12);
    item.buffer.copy(ico, imageOffset);
    imageOffset += item.buffer.length;
  });

  return ico;
}

function main() {
  const source = readPng(sourcePath);
  const crop = detectCrop(source);

  ensureDir(buildDir);
  ensureDir(iconsetDir);
  ensureDir(resourceIconDir);

  for (const [fileName, size] of iconsetEntries) {
    writePng(path.join(iconsetDir, fileName), renderIcon(source, crop, size));
  }

  const appPng = renderIcon(source, crop, outputPngSize);
  writePng(path.join(buildDir, "icon.png"), appPng);
  writePng(path.join(resourceIconDir, "app-icon.png"), appPng);
  writePng(rendererLogoPath, appPng);

  const buildIcnsPath = path.join(buildDir, "icon.icns");
  const resourceIcnsPath = path.join(resourceIconDir, "app-icon.icns");
  if (commandExists("iconutil")) {
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", buildIcnsPath], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    fs.copyFileSync(buildIcnsPath, resourceIcnsPath);
  } else if (fs.existsSync(buildIcnsPath) && fs.existsSync(resourceIcnsPath)) {
    console.warn("Skipped .icns generation because iconutil is unavailable.");
  } else {
    console.warn("Skipped .icns generation because iconutil is unavailable and no existing .icns files were found.");
  }

  const icoBuffers = icoSizes.map((size) => ({
    size,
    buffer: PNG.sync.write(renderIcon(source, crop, size)),
  }));
  const ico = makeIco(icoBuffers);
  fs.writeFileSync(path.join(buildDir, "icon.ico"), ico);
  fs.copyFileSync(path.join(buildDir, "icon.ico"), path.join(resourceIconDir, "app-icon.ico"));

  console.log(`Generated app icons from ${path.relative(repoRoot, sourcePath)} using crop x=${crop.x}, y=${crop.y}, size=${crop.size}.`);
}

main();
