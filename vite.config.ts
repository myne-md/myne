import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Compile-time injection of package.json version. Surfaces in the
  // Settings → About panel ("Myne 0.1.0"). `package.json` is the
  // single source of truth; reading it here keeps `tauri.conf.json`
  // version + AboutPanel display + bundle metadata in lockstep
  // without runtime JSON parsing or bundling unrelated package.json
  // fields into the WebView. Type declaration: `src/vite-env.d.ts`.
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },

  // Multi-page build: `pdf-export.html` is the hidden PDF-export render
  // window's page (MYND-255) — the Rust side loads it via
  // `WebviewUrl::App("pdf-export.html")` under the near-empty
  // `src-tauri/capabilities/pdf-export.json` capability. The dev server
  // serves it at /pdf-export.html automatically; the production build
  // needs the explicit rollup input so it lands in dist/.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        "pdf-export": fileURLToPath(
          new URL("./pdf-export.html", import.meta.url),
        ),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
