import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // TypeScript source wins over any leftover JavaScript artifact. Vite's
  // default order resolves "./app" to app.js first, which once meant the
  // whole dashboard silently shipped a months-old build while tsc checked
  // files nobody bundled. Keep the order explicit.
  resolve: { extensions: [".tsx", ".ts", ".jsx", ".js", ".json"] },
  server: {
    port: 5173,
    /* Same path the deployed nginx serves, so a dev browser and a built
     * deployment make identical requests. Without this the dev server would
     * call the API cross-origin and trip CORS. */
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
