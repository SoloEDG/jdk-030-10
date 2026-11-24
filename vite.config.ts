import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // decodeURIComponent keeps non-ASCII workspace paths usable by Rollup.
    alias: { "@": decodeURIComponent(new URL("./src", import.meta.url).pathname) },
  },
});
