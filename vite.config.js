import { cpSync } from "node:fs";
import { defineConfig } from "vite";

// Sounds (and the README gif) are referenced by runtime string paths like
// "assets/sounds/click-9.mp3", so they never enter the module graph. The dev
// server serves them from the project root as-is; for the build we copy the
// directory into dist verbatim.
const copyRuntimeAssets = () => ({
  name: "copy-runtime-assets",
  closeBundle() {
    cpSync("assets", "dist/assets", { recursive: true });
  },
});

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://<user>.github.io/server-survival/) without hardcoding the repo name.
  base: "./",
  plugins: [copyRuntimeAssets()],
});
