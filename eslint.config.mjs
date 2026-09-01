import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Nested worktrees under .claude/worktrees/ each have their own
    // .next/out/build output — root-anchored globs above don't match
    // those nested paths, so ESLint would otherwise crawl into and try
    // to lint another worktree's generated/minified build artifacts.
    ".claude/worktrees/**",
    // The attendance gateway is a satellite app, not part of this Next.js
    // project — plain CommonJS Node with its own runtime, its own Vercel
    // project, and no React. Linting it with eslint-config-next is meaningless.
    "attendance-gateway-code/**",
  ]),
  {
    rules: {
      // Data-fetching effects that call useCallback functions which set state
      // are a common and valid pattern in this codebase. The fetched data must
      // be stored in state, and the effect must run on dependency changes.
      "react-hooks/set-state-in-effect": "off",
      // Allow unused vars prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
