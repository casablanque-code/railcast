import { defineConfig } from "vitest/config";
import { cloudflareTest, cloudflarePool } from "@cloudflare/vitest-pool-workers";

// Test-only values so handlers that read these bindings don't blow up.
const workersOptions = {
  wrangler: { configPath: "./wrangler.toml" },
  miniflare: {
    bindings: {
      PUBLIC_FILE_BASE_URL: "https://dl.test.local",
      RESEND_API_KEY: "test-resend-key",
    },
  },
};

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  test: {
    pool: cloudflarePool(workersOptions),
    setupFiles: ["./test/setup.ts"],
  },
});
