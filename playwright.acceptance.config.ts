/** Local-only acceptance against the existing production build and isolated E2E fixtures. */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const origin = "http://127.0.0.1:3012";
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: origin },
  webServer: {
    command: "pnpm exec next start --hostname 127.0.0.1 --port 3012",
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{
    name: "chromium-local-acceptance",
    use: {
      browserName: "chromium",
      launchOptions: {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ["--no-proxy-server"],
      },
    },
  }],
});
