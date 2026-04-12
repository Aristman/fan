import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      // Type-only imports from api-gateway source (Vite won't bundle these)
      "@fan/api-gateway": new URL("../api-gateway/src/index.ts", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      // Suppress warnings from server-side dynamic imports in fan-ai
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" ||
            (warning.message?.includes("dynamic import cannot be analyzed"))) {
          return;
        }
        warn(warning);
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:3456",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
