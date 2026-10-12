import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: "katex-modern-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("katex.min.css")) return;
      return code.replace(/src:([^;]+);/g, (match, sources) => {
        const woff2 = sources.split(",").find((source: string) => source.includes("woff2"));
        return woff2 ? `src:${woff2};` : match;
      });
    },
  }],
  build: { assetsInlineLimit: Infinity, rollupOptions: { output: { inlineDynamicImports: true } } },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
