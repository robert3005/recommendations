import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
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
});
