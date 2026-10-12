import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Component tests for the dashboard: React Testing Library in jsdom, with the
// API client replaced by mocks (see test/dashboard.test.tsx). No Worker, no browser.
export default defineConfig({
  plugins: [react()],
  // tsconfig says jsx: "preserve" (Next compiles the JSX itself); tests need it compiled.
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx"],
  },
});
