import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4318",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev --port 4318 --strictPort",
    url: "http://localhost:4318",
    reuseExistingServer: !process.env.CI,
    env: {
      // Deterministic, network-free basemap for map-display tests.
      VITE_MAP_STYLE_URL: "/test-style.json",
    },
  },
});
