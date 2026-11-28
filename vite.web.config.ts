import { defineConfig } from "vite";

// Web playground, deployed to Firebase Hosting.
export default defineConfig(({ command }) => {
  // The App Check debug token is for the extension and local dev only. Every
  // VITE_ variable is inlined into the bundle, so blank it for production web
  // builds or it would ship publicly. Vite gives process.env priority over
  // .env files, and loads env after this config runs.
  if (command === "build") process.env.VITE_APPCHECK_DEBUG_TOKEN = "";

  return {
    build: { outDir: "dist/web", emptyOutDir: true, target: "es2022" },
  };
});
