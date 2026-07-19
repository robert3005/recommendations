import type { StorybookConfig } from "@storybook/react-vite";

// Storybook is a component workshop, not a deployable app: the production
// fail-closed provider check in vite.config.ts must not apply to its build.
process.env.PLACEMARKS_STORYBOOK = "1";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  staticDirs: ["../public"],
  viteFinal: (viteConfig) => {
    // The app's PWA service worker has no business inside Storybook's build.
    viteConfig.plugins = viteConfig.plugins
      ?.flat()
      .filter(
        (plugin) =>
          !(plugin && "name" in plugin && String(plugin.name).startsWith("vite-plugin-pwa")),
      );
    return viteConfig;
  },
};

export default config;
