import type { Preview } from "@storybook/react";

/**
 * Load kumo design-system CSS so story previews match runtime appearance.
 * The standalone bundle includes all component styles and the default kumo theme.
 */
import "@cloudflare/kumo/styles/standalone";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#ffffff" },
        { name: "dark", value: "#0d0d0d" },
      ],
    },
  },
};

export default preview;
