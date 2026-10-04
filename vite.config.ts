import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5189,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5188",
      "/docs": "http://127.0.0.1:5188",
    },
  },
  preview: { host: "127.0.0.1", port: 5189 },
});
