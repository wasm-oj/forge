import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "architecture-report/.next/**",
    "architecture-report/dist/**",
    ".vinext/**",
    ".playwright-cli/**",
    "output/**",
    "dist/**",
    "packages/*/dist/**",
    "lib/**",
    "public/toolchains/**",
    "problems/**",
    "src/runner/generated/**",
    "src/compiler/vendor/**",
    "src/judge/problems.generated.ts",
    "next-env.d.ts",
  ]),
]);
