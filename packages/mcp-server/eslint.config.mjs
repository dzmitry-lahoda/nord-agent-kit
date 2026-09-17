import parser from "@typescript-eslint/parser";
export default [
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@n1xyz/nord-ts/*", "**/ts/src/**"],
              message:
                "Use public SDK exports; protocol integration belongs in src/nord.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-debugger": "error",
      "no-unreachable": "error",
      "no-constant-binary-expression": "error",
      "no-unsafe-finally": "error",
      eqeqeq: "error",
    },
  },
];
