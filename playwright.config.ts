import { defineConfig, devices } from "@playwright/test";
const productionURL = process.env.QINGXING_E2E_URL;
export default defineConfig({
  testDir: "./tests",
  testMatch: "ui.spec.ts",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: productionURL || "http://127.0.0.1:5189",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: productionURL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://127.0.0.1:5189",
        reuseExistingServer: true,
        timeout: 60000,
      },
});
