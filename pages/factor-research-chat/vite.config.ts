import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 构建产物放到 Dashboard Pages 的 /research-chat/，同域 iframe 嵌入
export default defineConfig({
  plugins: [react()],
  base: "/research-chat/",
  build: {
    outDir: path.resolve(__dirname, "../factor-dashboard/research-chat"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY || "https://quant-factors-dashboard.pages.dev",
        changeOrigin: true,
      },
    },
  },
});
