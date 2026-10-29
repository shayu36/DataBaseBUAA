import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5189,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:5188", changeOrigin: false },
      "/docs": "http://127.0.0.1:5188",
    },
  },
  preview: { host: "127.0.0.1", port: 5189 },
});
