import type { Preview } from "@storybook/react";
import { initialize, mswLoader } from "msw-storybook-addon";
import { handlers } from "../src/mocks/handlers";
import { withProviders } from "./decorators";
import "../src/index.css";

// Storybook runs against the same MSW fixtures as vitest — one source of truth.
initialize({ onUnhandledRequest: "bypass" }, handlers);

const preview: Preview = {
  loaders: [mswLoader],
  decorators: [withProviders],
  parameters: {
    a11y: { test: "error" },
    layout: "padded",
  },
};

export default preview;
