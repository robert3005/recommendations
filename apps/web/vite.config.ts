import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Public/demo OSM endpoints are development-only (spec/src/data-sources.md):
 * tiles, geocoder search, and geocoder lookup all fail closed in production.
 * Search runs on Stadia Maps, a contracted provider, so it needs no
 * variable; an overriding VITE_STADIA_URL is checked like any provider URL.
 */
const BASE_REQUIRED_PROVIDER_VARS = ["VITE_OSM_API_URL"] as const;

/**
 * The basemap is either our own plate — over the tile service's per-tile URLs
 * or a self-hosted PMTiles archive, either way with self-hosted glyphs and
 * sprite — or a hosted style URL.
 */
const PLATE_ASSET_VARS = ["VITE_MAP_GLYPHS_URL", "VITE_MAP_SPRITE_URL"] as const;

/** The community/demo hosts the spec designates development-only. */
const DEVELOPMENT_ONLY_HOSTS = [
  "photon.komoot.io",
  "nominatim.openstreetmap.org",
  "api.openstreetmap.org",
  "master.apis.dev.openstreetmap.org",
  "tiles.openfreemap.org",
  "demotiles.maplibre.org",
  "protomaps.github.io",
] as const;

/**
 * Warm the connection to the basemap host while the app bundle is still
 * downloading: the plate's first request (the PMTiles header, glyphs, sprite)
 * otherwise pays DNS + TCP + TLS only after the map chunk has loaded — three
 * round trips, over 1.5 s on a 3G link. Only absolute, cross-origin URLs get
 * a hint; a same-origin path needs none.
 */
function basemapPreconnect(urls: (string | undefined)[]): Plugin {
  const origins = [
    ...new Set(
      urls.flatMap((value) => {
        if (!value || !/^https?:\/\//i.test(value)) return [];
        try {
          return [new URL(value).origin];
        } catch {
          return [];
        }
      }),
    ),
  ];
  return {
    name: "placemarks-basemap-preconnect",
    transformIndexHtml: () =>
      origins.map((href) => ({
        tag: "link",
        // MapLibre fetches tiles in CORS mode without credentials.
        attrs: { rel: "preconnect", href, crossorigin: "anonymous" },
        injectTo: "head" as const,
      })),
  };
}

/**
 * The map canvas is a lazy chunk so the notebook paints first, but waiting
 * for the entry to evaluate before even requesting it puts a full round trip
 * plus the entry's download in front of the map. A low-priority modulepreload
 * lets the browser fetch MapLibre while the shell loads, without competing
 * with the shell's own scripts for the link.
 */
function lowPriorityMapPreload(): Plugin {
  return {
    name: "placemarks-map-preload",
    apply: "build",
    transformIndexHtml(_html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return [];
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const canvas = chunks.find((c) => c.facadeModuleId?.endsWith("/src/map/MapCanvas.tsx"));
      if (!canvas) return [];
      const files = [...new Set([...canvas.imports, canvas.fileName])].filter((file) => {
        const chunk = bundle[file];
        // Shared chunks the entry already preloads need no second hint.
        return chunk?.type === "chunk" && !chunk.isEntry && !ctx.chunk?.imports.includes(file);
      });
      return files.map((file) => ({
        tag: "link",
        attrs: { rel: "modulepreload", href: `/${file}`, fetchpriority: "low", crossorigin: "" },
        injectTo: "head" as const,
      }));
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const hintEnv = { ...process.env, ...loadEnv(mode, process.cwd(), "VITE_") };
  // Storybook's static build is a component workshop, never a deployment.
  if (command === "build" && mode === "production" && !process.env.PLACEMARKS_STORYBOOK) {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const providerValue = (key: string) => env[key] ?? process.env[key];
    // Search defaults to Stadia Maps and needs no variable; an overriding
    // VITE_STADIA_URL is validated like every other provider.
    const searchVars = providerValue("VITE_STADIA_URL") ? ["VITE_STADIA_URL"] : [];
    const basemapVars = providerValue("VITE_MAP_TILES_URL")
      ? (["VITE_MAP_TILES_URL", ...PLATE_ASSET_VARS] as const)
      : providerValue("VITE_MAP_PMTILES_URL")
        ? (["VITE_MAP_PMTILES_URL", ...PLATE_ASSET_VARS] as const)
        : (["VITE_MAP_STYLE_URL"] as const);
    const requiredProviderVars = [...basemapVars, ...BASE_REQUIRED_PROVIDER_VARS, ...searchVars];
    const missing = requiredProviderVars.filter((key) => !providerValue(key));
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
      if (!value?.startsWith("/")) return false;
      try {
        new URL(value, "https://self.invalid");
        return true;
      } catch {
        return false;
      }
    };
    const malformed = requiredProviderVars.filter((key) => {
      const value = providerValue(key);
      return hostnameOf(value) === undefined && !isRelativePath(value);
    });
    if (malformed.length > 0) {
      throw new Error(
        `production build fails closed: ${malformed.join(", ")} are not valid provider URLs — ` +
          "point every VITE_ provider variable at a contracted or self-hosted deployment.",
      );
    }
    // A personal test deployment is a development configuration
    // (spec/src/data-sources.md): PLACEMARKS_TEST_DEPLOY=1 lets search and
    // lookup use the public OSM API there, at development volumes.
    // The basemap never qualifies, and the flag is a build-time variable that
    // never reaches the client.
    const testDeploy = process.env.PLACEMARKS_TEST_DEPLOY === "1";
    const demoGeocoderVars = new Set(["VITE_OSM_API_URL"]);
    const demo = requiredProviderVars.filter(
      (key) =>
        !(testDeploy && demoGeocoderVars.has(key)) &&
        DEVELOPMENT_ONLY_HOSTS.some((host) => hostnameOf(providerValue(key)) === host),
    );
    if (testDeploy) {
      console.warn(
        "PLACEMARKS_TEST_DEPLOY=1: lookup may use the public OSM API — " +
          "test deployments only, never production.",
      );
    }
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
      basemapPreconnect([
        hintEnv.VITE_MAP_TILES_URL?.replace(/\{[^}]*\}/g, "0"),
        hintEnv.VITE_MAP_PMTILES_URL,
        hintEnv.VITE_MAP_GLYPHS_URL?.replace(/\{[^}]*\}/g, "x"),
        hintEnv.VITE_MAP_SPRITE_URL,
        hintEnv.VITE_MAP_STYLE_URL,
      ]),
      lowPriorityMapPreload(),
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
          theme_color: "#FCFCF9",
          background_color: "#FCFCF9",
          display: "standalone",
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          // Split the heavyweights so each precached file stays well under the
          // workbox 2 MiB limit. Only libraries the first launch needs belong
          // in a group here: naming a library pins it into that chunk, so
          // grouping a lazy-only dependency (zod, fflate) with a launch one
          // (dexie) would drag it back onto the critical path. Markdown has no
          // group on purpose: a group hoists shared modules such as
          // react/jsx-runtime into it, which made the entry preload the whole
          // Markdown stack. Rollup's own split keeps it with the lazy routes.
          manualChunks: {
            maplibre: ["maplibre-gl"],
            data: ["dexie", "dexie-react-hooks"],
          },
        },
      },
    },
    server: {
      port: 5173,
    },
  };
});
