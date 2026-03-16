import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig(({ command }) => ({
  // For Electron builds (file://), a relative base avoids broken asset paths.
  base: command === "serve" ? "/" : "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Enables SharedArrayBuffer so onnxruntime-web can use the threaded WASM build.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // Proxy WebSocket connections to the local Node backend during development.
    proxy: {
      "/ws-node": {
        target: "ws://127.0.0.1:8766",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        ocrFinetuning: resolve(__dirname, "ocr_finetuning.html"),
      },
    },
  },
  optimizeDeps: {
    // Exclude onnxruntime-web from pre-bundling - it has its own module loading.
    exclude: ["onnxruntime-web"],
  },
  assetsInclude: ["**/*.wasm"],
}));
