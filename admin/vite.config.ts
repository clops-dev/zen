import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The SPA is mounted at /admin2 on the backend. Setting `base` to that
// path makes Vite emit <script src="/admin2/assets/...> in the built
// index.html, which means the HTML works without server-side rewriting
// and we can drop the path-mangling in server.ts.
export default defineConfig({
  plugins: [react()],
  base: "/admin2/",
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/admin-api": "http://localhost:8787",
      "/v1/auth": "http://localhost:8787",
      "/login": "http://localhost:8787",
      "/logout": "http://localhost:8787",
    },
  },
})