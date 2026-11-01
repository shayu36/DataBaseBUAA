import { defineConfig, devices } from "@playwright/test";
import { serviceConfig } from "./config/services.mjs";
const { frontendURL } = serviceConfig();
const productionURL = process.env.QINGXING_E2E_URL;
export default defineConfig({
  testDir: "./tests",
  testMatch: "ui.spec.ts",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: productionURL || frontendURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: productionURL
    ? undefined
    : {
        command: "npm run dev",
        url: frontendURL,
        reuseExistingServer: true,
        timeout: 60000,
      },
});
