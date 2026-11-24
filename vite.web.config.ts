import { defineConfig } from "vite";

// Web playground, deployed to Firebase Hosting.
export default defineConfig({
  build: { outDir: "dist/web", emptyOutDir: true, target: "es2022" },
});
