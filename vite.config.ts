import { defineConfig } from "vite";
import path from "node:path";
import { folioApi } from "./server/devApi";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  plugins: [
    // In the Tauri app these requests go to Rust instead; the plugin only matters in a browser.
    folioApi({
      defaultRoot: process.env.FOLIO_ROOT ?? path.resolve(__dirname, "examples/book"),
      kernelScript: path.resolve(__dirname, "kernel/folio_kernel.py"),
    }),
  ],
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/examples/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "safari15",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
