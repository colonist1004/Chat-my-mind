import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: { target: "es2022" },
  // 개발 중에는 /api 요청을 로컬 서버(npm run dev:server)로 넘깁니다.
  server: { proxy: { "/api": "http://localhost:8787" } },
});
