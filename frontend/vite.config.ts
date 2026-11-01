import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { serviceConfig } from "../config/services.mjs";

export default defineConfig(() => {
  const { backendPort, frontendPort, backendURL } = serviceConfig();
  if (backendPort === frontendPort)
    throw new Error("前后端端口不能相同，请调整 PORT 或 FRONTEND_PORT");
  const proxy = {
    "/api": { target: backendURL, changeOrigin: false },
    "/docs": { target: backendURL, changeOrigin: false },
  };
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    build: { outDir: "../dist", emptyOutDir: true },
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: frontendPort,
      strictPort: true,
      proxy,
    },
    preview: { host: "127.0.0.1", port: frontendPort, strictPort: true, proxy },
  };
});
