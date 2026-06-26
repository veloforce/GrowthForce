import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/claude",
  timeout: 180_000,
  workers: 1,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});
