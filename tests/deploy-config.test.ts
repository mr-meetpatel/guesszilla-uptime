import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseWranglerConfig } from "../scripts/wrangler-config.mjs";

it("reads the actual Wrangler JSONC configuration used by deployment", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const config = parseWranglerConfig(source);
  expect(config.main).toBe("worker/index.ts");
  expect(
    config.d1_databases.some((db: { binding: string }) => db.binding === "DB"),
  ).toBe(true);
});

it("accepts comments and trailing commas without changing string values", () => {
  expect(
    parseWranglerConfig(`{
      // Configuration comment
      "value": "keep,} // text",
      "items": [1, 2,], /* block comment */
    }`),
  ).toEqual({ value: "keep,} // text", items: [1, 2] });
});

it("rejects invalid JSONC instead of deploying a partially parsed config", () => {
  expect(() => parseWranglerConfig('{"main": }')).toThrow(
    "Invalid wrangler.jsonc",
  );
});
