import { history, record, RETENTION, type Env, type Sample } from "./monitor";

function json(body: unknown, status = 200, cache = false) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": cache ? "public, max-age=30" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405);
    try {
      if (url.pathname === "/api/status") {
        const latest = await env.DB.prepare(
          "SELECT * FROM checks ORDER BY slot DESC LIMIT 1",
        ).first<Sample>();
        const success = await env.DB.prepare(
          "SELECT checked_at FROM checks WHERE status = 'operational' ORDER BY slot DESC LIMIT 1",
        ).first<{ checked_at: number }>();
        return json(
          {
            snapshot: latest ? JSON.parse(latest.payload) : null,
            checked_at: latest?.checked_at ?? null,
            last_success_at: success?.checked_at ?? null,
            stale: !latest || Date.now() - latest.checked_at > 600_000,
          },
          200,
          true,
        );
      }
      if (url.pathname === "/api/history") {
        const window = url.searchParams.get("window") ?? "24h";
        if (window !== "24h") return json({ error: "invalid_window" }, 400);
        const end = Date.now();
        const start = end - RETENTION;
        const { results } = await env.DB.prepare(
          "SELECT slot, status FROM checks WHERE slot >= ? AND slot <= ? ORDER BY slot",
        )
          .bind(start, end)
          .all<Pick<Sample, "slot" | "status">>();
        return json({ window, ...history(results, start, end) }, 200, true);
      }
      return json({ error: "not_found" }, 404);
    } catch {
      console.error(JSON.stringify({ event: "monitor_storage_unavailable" }));
      return json({ error: "monitor_storage_unavailable" }, 503);
    }
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    try {
      await record(env, event.scheduledTime);
    } catch {
      console.error(JSON.stringify({ event: "scheduled_check_failed" }));
      throw new Error("scheduled_check_failed");
    }
  },
};
