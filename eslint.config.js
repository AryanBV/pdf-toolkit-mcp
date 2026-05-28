import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "scripts/**",
      ".remember/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // CLAUDE.md Rule 1: stdout is the MCP transport channel. console.warn/error
      // go to stderr (allowed); console.log/info/debug would corrupt the protocol.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettier,
);
