import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", worker: "src/main/worker.ts", "pdf-worker": "src/main/pdf-worker.ts" },
      },
    },
  },
  preload: { build: { rollupOptions: { input: "src/preload/index.ts" } } },
  renderer: {
    plugins: [
      react(),
      {
        name: "dev-csp",
        transformIndexHtml(html, context) {
          return context.server
            ? html.replace(
                /<meta\s+http-equiv="Content-Security-Policy"[^>]*\/?>/g,
                "",
              )
            : html;
        },
      },
    ],
    root: "src/renderer",
    build: {
      rollupOptions: { input: "src/renderer/index.html" },
      minify: true,
    },
  },
});
