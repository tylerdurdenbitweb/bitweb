import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "contracts/**/*.test.ts"],
  },
});
