import { defineConfig } from "vitest/config";
import { cloudflareTest, cloudflarePool } from "@cloudflare/vitest-pool-workers";

// Test-only values so handlers that read these bindings don't blow up.
const workersOptions = {
  wrangler: { configPath: "./wrangler.toml" },
  miniflare: {
    bindings: {
      PUBLIC_FILE_BASE_URL: "https://dl.test.local",
      RESEND_API_KEY: "test-resend-key",
      // Small on purpose: existing tests only ever upload a few bytes, and
      // keeping this tiny lets the size-limit tests exceed it without
      // generating huge bodies. Production uses the real wrangler.toml value.
      MAX_UPLOAD_BYTES: "1024",
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
