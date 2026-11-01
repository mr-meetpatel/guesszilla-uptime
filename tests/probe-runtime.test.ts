import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it.each([200, 302])(
  "probes HTTP %s through the actual Workers fetch implementation",
  async (status) => {
    const source = await readFile(
      new URL("../worker/monitor.ts", import.meta.url),
      "utf8",
    );
    let requests = 0;
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: [
          {
            type: "ESModule",
            path: "index.mjs",
            contents: `import { probe } from "./monitor.mjs";
              export default {
                async fetch() {
                  return Response.json(await probe("https://backend.example/health/status"));
                }
              };`,
          },
          {
            type: "ESModule",
            path: "monitor.mjs",
            contents: stripTypeScriptTypes(source),
          },
        ],
        compatibilityDate: "2026-10-30",
        outboundService: async () => {
          requests++;
          if (status === 302)
            return new Response(null, {
              status,
              headers: { Location: "https://other.example/health/status" },
            });
          return Response.json({
            checked_at: new Date().toISOString(),
            status: "operational",
            backend: { status: "up" },
            database: { status: "up" },
            worker: { status: "up" },
            scheduler: { status: "up" },
          });
        },
      }),
    );
    try {
      const response = await runtime.dispatchFetch("http://monitor.example");
      expect(await response.json()).toMatchObject({
        status: status === 200 ? "operational" : "unavailable",
      });
      expect(requests).toBe(1);
    } finally {
      await runtime.dispose();
    }
  },
);
