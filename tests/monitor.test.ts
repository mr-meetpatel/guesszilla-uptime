import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import worker from "../worker/index";
import {
  history,
  INTERVAL,
  probe,
  record,
  type Env,
  type Snapshot,
} from "../worker/monitor";
let mf: Miniflare;
let env: Env;
const good = (): Snapshot => ({
  checked_at: new Date().toISOString(),
  status: "operational",
  backend: { status: "up" },
  database: { status: "up", latency_ms: 12 },
  worker: { status: "up" },
  scheduler: { status: "up" },
});
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { DB: "test-db" },
    }),
  );
  const db = await mf.getD1Database("DB");
  await db.exec(
    (
      await readFile(
        new URL("../migrations/0001_checks.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("\n", " "),
  );
  env = {
    DB: db as unknown as D1Database,
    BACKEND_STATUS_URL: "https://backend.example/health/status",
    ASSETS: {} as Fetcher,
  };
});
afterAll(async () => {
  await mf.dispose();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM checks").run();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("accepts healthy/degraded JSON and strips unrecognized fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...good(), secret: "do-not-persist" }),
      ),
  );
  expect(await probe(env.BACKEND_STATUS_URL)).not.toHaveProperty("secret");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { ...good(), status: "degraded", database: { status: "down" } },
          { status: 503 },
        ),
      ),
  );
  expect((await probe(env.BACKEND_STATUS_URL)).database.status).toBe("down");
});
it("accepts a delayed cold-start response without retrying", async () => {
  const fetcher = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json(good());
  });
  vi.stubGlobal("fetch", fetcher);
  expect((await probe(env.BACKEND_STATUS_URL)).status).toBe("operational");
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([
  "timeout",
  "network",
  "html",
  "invalid",
  "oversize",
  "stale",
  "inconsistent",
])("reports unknown database for %s", async (failure) => {
  const fetcher = vi.fn();
  if (failure === "timeout")
    fetcher.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  if (failure === "network")
    fetcher.mockRejectedValue(new Error("secret transport error"));
  if (failure === "html")
    fetcher.mockResolvedValue(new Response("Render loading", { status: 503 }));
  if (failure === "invalid")
    fetcher.mockResolvedValue(Response.json({ status: "up" }));
  if (failure === "oversize")
    fetcher.mockResolvedValue(
      Response.json({ ...good(), huge: "x".repeat(17000) }),
    );
  if (failure === "stale")
    fetcher.mockResolvedValue(
      Response.json({ ...good(), checked_at: new Date(0).toISOString() }),
    );
  if (failure === "inconsistent")
    fetcher.mockResolvedValue(
      Response.json({ ...good(), database: { status: "down" } }),
    );
  vi.stubGlobal("fetch", fetcher);
  const result = await probe(env.BACKEND_STATUS_URL);
  expect(result.backend.status).toBe("down");
  expect(result.database.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("records one sample per slot, prunes 25-hour history and keeps 23-hour history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json(good())),
  );
  const now = Math.floor(Date.now() / INTERVAL) * INTERVAL;
  const hour = 60 * 60 * 1000;
  await env.DB.prepare("INSERT INTO checks VALUES (?, ?, ?, ?)")
    .bind(
      now - 25 * hour,
      now - 25 * hour,
      "operational",
      JSON.stringify(good()),
    )
    .run();
  await env.DB.prepare("INSERT INTO checks VALUES (?, ?, ?, ?)")
    .bind(
      now - 23 * hour,
      now - 23 * hour,
      "operational",
      JSON.stringify(good()),
    )
    .run();
  await Promise.all([record(env, now), record(env, now)]);
  await record(env, now + 1000);
  expect(
    (await env.DB.prepare("SELECT * FROM checks").all()).results,
  ).toHaveLength(2);
});
it("serves stored data without probing and detects stale results", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(good()));
  vi.stubGlobal("fetch", fetcher);
  const now = Date.now();
  await record(env, now);
  fetcher.mockClear();
  const response = await worker.fetch(
    new Request("https://status.example/api/status"),
    env,
  );
  expect(response.headers.get("Cache-Control")).toContain("max-age=30");
  expect(await response.json()).toMatchObject({ stale: false });
  await env.DB.prepare("UPDATE checks SET checked_at = ?")
    .bind(now - 700_000)
    .run();
  expect(
    await (
      await worker.fetch(new Request("https://status.example/api/status"), env)
    ).json(),
  ).toMatchObject({ stale: true });
  expect(fetcher).not.toHaveBeenCalled();
});
it("handles first run and validates history windows", async () => {
  expect(
    await (
      await worker.fetch(new Request("https://status.example/api/status"), env)
    ).json(),
  ).toMatchObject({ snapshot: null, stale: true });
  expect(
    (
      await worker.fetch(
        new Request("https://status.example/api/history?window=all"),
        env,
      )
    ).status,
  ).toBe(400);
  expect(
    await (
      await worker.fetch(
        new Request("https://status.example/api/history?window=24h"),
        env,
      )
    ).json(),
  ).toMatchObject({ uptime_percent: null, coverage_percent: 0 });
  expect(
    (
      await worker.fetch(
        new Request("https://status.example/api/history?window=7d"),
        env,
      )
    ).status,
  ).toBe(400);
});
it("storage failures do not expose D1 internals", async () => {
  const broken = {
    ...env,
    DB: {
      prepare() {
        throw new Error("secret-db-id");
      },
    } as unknown as D1Database,
  };
  const response = await worker.fetch(
    new Request("https://status.example/api/status"),
    broken,
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
  await expect(
    worker.scheduled(
      { scheduledTime: Date.now() } as ScheduledController,
      broken,
    ),
  ).rejects.toThrow("scheduled_check_failed");
});
it("gaps are excluded from uptime and split incidents", () => {
  const sample = (slot: number, status: "operational" | "degraded") => ({
    slot,
    checked_at: slot,
    status,
    payload: "{}",
  });
  const result = history(
    [
      sample(0, "degraded"),
      sample(INTERVAL, "degraded"),
      sample(3 * INTERVAL, "degraded"),
      sample(4 * INTERVAL, "operational"),
    ],
    0,
    5 * INTERVAL,
  );
  expect(result.coverage_percent).toBe(80);
  expect(result.uptime_percent).toBe(25);
  expect(result.incidents).toHaveLength(2);
  expect(result.slots[2].status).toBe("unknown");
});
