import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default defineConfig([
  globalIgnores(["dist/", "node_modules/"]),
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tsparser, sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs["eslint-recommended"].rules,
      ...tseslint.configs.recommended.rules,
      "no-console": "off",
    },
  },
]);
