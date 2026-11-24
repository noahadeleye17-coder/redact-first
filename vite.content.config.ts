import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/extension",
    emptyOutDir: false, // runs after the main extension build
    target: "es2022",
    lib: {
      entry: resolve(__dirname, "src/ext/content.ts"),
      formats: ["iife"],
      name: "RedactFirstContent",
      fileName: () => "content.js",
    },
  },
});
