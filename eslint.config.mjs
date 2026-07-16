import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    ".vinext/**",
    ".playwright-cli/**",
    "dist/**",
    "public/toolchains/**",
    "next-env.d.ts",
  ]),
]);
