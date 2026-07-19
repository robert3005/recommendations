import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    // End-of-test captures double as a visual record of each flow.
    screenshot: "on",
    // Deterministic start camera: the map opens on a timezone-derived
    // approximate location (src/lib/viewport.ts), so the zone must be pinned.
    timezoneId: "Europe/Lisbon",
  },
  projects: [
    {
      // Dev server + MSW fixtures: map display, save flows, guides, backup, repair.
      name: "chromium",
      testIgnore: /offline/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4318" },
    },
    {
      // Production build + service worker: the offline-shell guarantee (Phase 0).
      name: "offline-preview",
      testMatch: /offline/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4319" },
    },
  ],
  webServer: [
    {
      command: "pnpm dev --port 4318 --strictPort",
      url: "http://localhost:4318",
      reuseExistingServer: !process.env.CI,
      env: {
        // Deterministic, network-free basemap for map-display tests.
        VITE_MAP_STYLE_URL: "/test-style.json",
        // OSM/Photon/Overpass served by MSW fixtures — e2e never hits public services.
        VITE_ENABLE_MSW: "true",
      },
    },
    {
      command: "pnpm build && pnpm preview --port 4319 --strictPort",
      url: "http://localhost:4319",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        VITE_MAP_STYLE_URL: "/test-style.json",
        // The production build fails closed without explicit provider config;
        // the offline test never touches these, they just must be explicit.
        VITE_PHOTON_URL: "http://localhost:4319",
        VITE_OSM_API_URL: "http://localhost:4319",
        VITE_OVERPASS_URL: "http://localhost:4319",
      },
    },
  ],
});
