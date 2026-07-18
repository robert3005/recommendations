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
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
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
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
  },
});
