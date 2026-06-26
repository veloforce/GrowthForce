import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: path.join(__dirname, "src/renderer"),
  publicDir: path.join(__dirname, "public"),
  build: {
    outDir: path.join(__dirname, "dist/renderer"),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      "@shared": path.join(__dirname, "src/shared")
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
