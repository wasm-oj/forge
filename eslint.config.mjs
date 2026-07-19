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
    "lib/**",
    "public/toolchains/**",
    "problems/**",
    "src/runner/generated/**",
    "src/judge/problems.generated.ts",
    "next-env.d.ts",
  ]),
]);
