#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

npm run build:renderer >/tmp/agentstudio-browser-build.log 2>&1

PORT="${AGENTSTUDIO_BROWSER_TEST_PORT:-4173}"
LOG_FILE="/tmp/agentstudio-vite-preview-${PORT}.log"
node tests/smoke/serve-renderer.mjs --port "$PORT" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:${PORT}" >/dev/null

AGENTSTUDIO_BROWSER_TEST_URL="http://127.0.0.1:${PORT}" node - <<'NODE'
const { chromium } = require("@playwright/test");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(process.env.AGENTSTUDIO_BROWSER_TEST_URL, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    if (!title.includes("小G")) {
      throw new Error(`Unexpected page title: ${title}`);
    }
    await page.getByText("小G").waitFor({ timeout: 10_000 });
    await page.getByText("我是小G").waitFor({ timeout: 10_000 });
    await page.getByText("当前页面未运行在 Electron 环境，无法连接桌面端能力。").waitFor({ timeout: 10_000 });
    const body = await page.locator("body").innerText();
    for (const expected of ["小G · GrowthForce", "我是小G", "工作台"]) {
      if (!body.includes(expected)) throw new Error(`Missing expected text: ${expected}`);
    }
    if (!body.includes("当前页面未运行在 Electron 环境，无法连接桌面端能力。")) {
      throw new Error("Missing Electron-only notice in browser test");
    }
  } finally {
    await browser.close();
  }
})();
NODE

echo "renderer static browser checks passed."
