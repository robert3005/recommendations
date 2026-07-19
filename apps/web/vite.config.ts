import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Public/demo OSM endpoints are development-only (book/src/data-sources.md). */
const REQUIRED_PROVIDER_VARS = [
  "VITE_MAP_STYLE_URL",
  "VITE_PHOTON_URL",
  "VITE_OSM_API_URL",
  "VITE_OVERPASS_URL",
] as const;

/** The community/demo hosts the book designates development-only. */
const DEVELOPMENT_ONLY_HOSTS = [
  "photon.komoot.io",
  "overpass-api.de",
  "api.openstreetmap.org",
  "master.apis.dev.openstreetmap.org",
  "tiles.openfreemap.org",
  "demotiles.maplibre.org",
] as const;

export default defineConfig(({ command, mode }) => {
  // Storybook's static build is a component workshop, never a deployment.
  if (command === "build" && mode === "production" && !process.env.PLACEMARKS_STORYBOOK) {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const valueOf = (key: string) => env[key] ?? process.env[key];
    const missing = REQUIRED_PROVIDER_VARS.filter((key) => !valueOf(key));
    if (missing.length > 0) {
      throw new Error(
        `production build fails closed: missing provider configuration ${missing.join(", ")} — ` +
          "public/demo OSM endpoints are development-only (book/src/data-sources.md); point " +
          "every VITE_ provider variable at a contracted or self-hosted deployment.",
      );
    }
    // Copying the development/demo URLs into env vars is not a production
    // provider path — the public community services must not carry deployments.
    const demo = REQUIRED_PROVIDER_VARS.filter((key) =>
      // Host names are case-insensitive — normalize before matching.
      DEVELOPMENT_ONLY_HOSTS.some((host) => (valueOf(key) ?? "").toLowerCase().includes(host)),
    );
    if (demo.length > 0) {
      throw new Error(
        `production build fails closed: ${demo.join(", ")} point at development/demo provider ` +
          "endpoints (book/src/data-sources.md); a production provider path must be a contracted " +
          "or self-hosted deployment.",
      );
    }
  }
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        // Cached app shell so an already-opened installation launches offline (Phase 0).
        workbox: {
          // json included so a locally-served style (e.g. the e2e fixture) renders offline.
          globPatterns: ["**/*.{js,css,html,svg,woff2,json}"],
          // Never cache map tiles or OSM services — provider policies forbid bulk caching.
          runtimeCaching: [],
        },
        manifest: {
          name: "Placemarks",
          short_name: "Placemarks",
          description: "Your personal map of places, built on OpenStreetMap.",
          theme_color: "#1c1917",
          background_color: "#fafaf9",
          display: "standalone",
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          // Split the heavyweights so each precached file stays well under the
          // workbox 2 MiB limit and the map/markdown stacks load in parallel.
          manualChunks: {
            maplibre: ["maplibre-gl"],
            markdown: ["react-markdown", "remark-gfm", "rehype-sanitize"],
            hours: ["opening_hours"],
            data: ["dexie", "dexie-react-hooks", "fflate", "zod"],
          },
        },
      },
    },
    server: {
      port: 5173,
    },
  };
});
