import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Public/demo OSM endpoints are development-only (spec/src/data-sources.md). */
const REQUIRED_PROVIDER_VARS = [
  "VITE_MAP_STYLE_URL",
  "VITE_PHOTON_URL",
  "VITE_OSM_API_URL",
  "VITE_OVERPASS_URL",
] as const;

/** The community/demo hosts the spec designates development-only. */
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
    const providerValue = (key: string) => env[key] ?? process.env[key];
    const missing = REQUIRED_PROVIDER_VARS.filter((key) => !providerValue(key));
    if (missing.length > 0) {
      throw new Error(
        `production build fails closed: missing provider configuration ${missing.join(", ")} — ` +
          "public/demo OSM endpoints are development-only (spec/src/data-sources.md); point " +
          "every VITE_ provider variable at a contracted or self-hosted deployment.",
      );
    }
    // Copying the development/demo URLs into env vars is not a production
    // provider path. Matching operates on the parsed, canonical hostname:
    // encoded dots cannot hide a demo host, a trailing root-dot spelling is
    // the same host, and demo-looking text in a path or a longer unrelated
    // hostname is not a match. A value that does not parse as a URL at all is
    // not a provider path either — the build fails closed rather than
    // shipping a config nothing can fetch from.
    const hostnameOf = (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      try {
        return new URL(value).hostname.toLowerCase().replace(/\.+$/, "");
      } catch {
        return undefined;
      }
    };
    // A same-origin relative path (a self-hosted style/endpoint served with
    // the app) is a valid production configuration with no hostname of its
    // own; anything that parses as neither absolute nor relative is not a
    // provider path at all.
    const isRelativePath = (value: string | undefined): boolean => {
      if (!value || !value.startsWith("/")) return false;
      try {
        new URL(value, "https://self.invalid");
        return true;
      } catch {
        return false;
      }
    };
    const malformed = REQUIRED_PROVIDER_VARS.filter((key) => {
      const value = providerValue(key);
      return hostnameOf(value) === undefined && !isRelativePath(value);
    });
    if (malformed.length > 0) {
      throw new Error(
        `production build fails closed: ${malformed.join(", ")} are not valid provider URLs — ` +
          "point every VITE_ provider variable at a contracted or self-hosted deployment.",
      );
    }
    const demo = REQUIRED_PROVIDER_VARS.filter((key) =>
      DEVELOPMENT_ONLY_HOSTS.some((host) => hostnameOf(providerValue(key)) === host),
    );
    if (demo.length > 0) {
      throw new Error(
        `production build fails closed: ${demo.join(", ")} point at development/demo provider ` +
          "endpoints (spec/src/data-sources.md); a production provider path must be a contracted " +
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
