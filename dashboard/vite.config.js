import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
export default defineConfig({
  esbuild: { legalComments: "inline" },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../canaveral/web",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        banner:
          "/*!\n" +
          readFileSync(
            new URL("./src/components/ui/LICENSE.md", import.meta.url),
            "utf8",
          ) +
          "\n*/",
        entryFileNames: "app.js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".woff2"))
            ? "geist-mono.woff2"
            : asset.names.some((name) => name.endsWith(".css"))
              ? "style.css"
              : "[name][extname]",
      },
    },
  },
  test: {
    include: ["src/**/*.test.{js,jsx,ts,tsx}"],
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    restoreMocks: true,
  },
});
