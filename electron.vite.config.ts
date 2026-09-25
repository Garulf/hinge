import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    // @yume-chan/pcm-player@3.0.0-beta.3 (pinned by the M5 plan) is not
    // installed in this worktree's shared node_modules; externalizing it
    // lets the build succeed without physically resolving the package. See
    // src/renderer/pcm-player.d.ts for the full explanation. Remove this
    // once the package is actually installed.
    build: { rollupOptions: { external: ["@yume-chan/pcm-player"] } },
  },
});
