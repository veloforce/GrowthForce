import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/electron",
  timeout: 45_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});
