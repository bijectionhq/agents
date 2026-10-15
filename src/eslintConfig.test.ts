// concave:begin canonical-package-bridge-test-imports
// why: Resolve the actual flat configuration before checking the canonical entry's precise import rule.
// preserves: eslint.config.js#provider-adapter-confinement
// witness: src/eslintConfig.test.ts
// remove-when: Upstream provides the same canonical package bridge.
import { ESLint, Linter } from "eslint";
import { fileURLToPath } from "node:url";
// concave:end canonical-package-bridge-test-imports
import { describe, expect, it } from "vitest";

describe("provider adapter boundary lint selectors", () => {
// concave:begin canonical-package-bridge-witness
// why: Exercise the canonical bridge and refuse every broader provider escape.
// preserves: eslint.config.js#provider-adapter-confinement
// witness: src/eslintConfig.test.ts
// remove-when: Upstream provides the same canonical package bridge.
  it("allows the exact canonical export while rejecting other adapter entry points", async () => {
    const eslint = new ESLint({
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    });
    async function messages(filePath: string, text: string) {
      const config = await eslint.calculateConfigForFile(filePath);
      return new Linter({ configType: "flat" }).verify(text, {
        languageOptions: { ecmaVersion: 2020, sourceType: "module" },
        rules: {
          "no-restricted-imports": config.rules["no-restricted-imports"],
          "no-restricted-syntax": config.rules["no-restricted-syntax"],
        },
      });
    }
    expect(
      await messages("src/index.ts", 'export * from "./vercel/index.js";'),
    ).toEqual([]);
    for (const [filePath, text] of [
      ["src/index.ts", 'export * from "./vercel/client/start.js";'],
      ["src/index.ts", 'import("./vercel/index.js");'],
      ["src/index.ts", 'import { generateText } from "ai";'],
      ["src/component/files.ts", 'export * from "../vercel/index.js";'],
    ]) {
      const result = await messages(filePath!, text!);
      expect(
        result.some((message) => message.ruleId?.startsWith("no-restricted")),
      ).toBe(true);
    }
  });
// concave:end canonical-package-bridge-witness
  it("parse on Node 20 and reject every restricted dynamic import shape", async () => {
    const configUrl = new URL("../eslint.config.js", import.meta.url).href;
    const { default: eslintConfig } = (await import(configUrl)) as {
      default: Array<{
        files?: string[];
        rules?: Record<string, unknown>;
      }>;
    };
    const boundaryConfig = eslintConfig.find(
      (config) =>
        "files" in config &&
        config.files?.some((pattern) => pattern.includes("src/streaming/")) &&
        config.rules?.["no-restricted-syntax"],
    );
    const restrictedSyntax = boundaryConfig?.rules?.["no-restricted-syntax"];
    expect(restrictedSyntax).toBeDefined();

    const messages = new Linter({ configType: "flat" }).verify(
      [
        'import("ai");',
        'import("ai/test");',
        'import("@ai-sdk/provider");',
        'import("vercel");',
        'import("vercel/test");',
        'import("../vercel");',
        'import("../vercel/test");',
      ].join("\n"),
      {
        languageOptions: { ecmaVersion: 2020, sourceType: "module" },
        rules: {
          "no-restricted-syntax": restrictedSyntax as Linter.RuleEntry,
        },
      },
    );

    expect(messages).toHaveLength(7);
    expect(messages.every((message) => message.ruleId === "no-restricted-syntax"))
      .toBe(true);
  });
});
