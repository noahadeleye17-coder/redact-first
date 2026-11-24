import { resolve } from "node:path";
import { defineConfig } from "vite";

// Chrome extension: side panel page + module service worker.
// The content script is built separately (vite.content.config.ts) because it
// has to be a single classic script with no imports.
export default defineConfig({
  publicDir: "ext-static",
  build: {
    outDir: "dist/extension",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        background: resolve(__dirname, "src/ext/background.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
