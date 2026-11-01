import type { State, Component, Snapshot, Sample } from "../shared/types";
export type { Snapshot, Sample } from "../shared/types";
export const INTERVAL = 60_000;
export const RETENTION = 7 * 24 * 60 * 60 * 1000;
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BACKEND_STATUS_URL: string;
}
const states: State[] = ["up", "down", "unknown", "not_applicable"];

function component(value: unknown): Component {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    !states.includes(value.status as State)
  )
    throw new Error("invalid_component");
  const result: Component = { status: value.status as State };
  for (const key of ["latency_ms", "heartbeat_age_seconds"] as const) {
    if (key in value) {
      const metric = (value as Record<string, unknown>)[key];
      if (
        metric !== null &&
        (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)
      )
        throw new Error("invalid_metric");
      result[key] = metric as number | null;
    }
  }
  return result;
}

export async function probe(url: string): Promise<Snapshot> {
  const unknown: Component = { status: "unknown" };
  const fallback: Snapshot = {
    checked_at: new Date().toISOString(),
    status: "unavailable",
    backend: { status: "down" },
    database: unknown,
    worker: unknown,
    scheduler: unknown,
  };
  try {
    const target = new URL(url);
    if (
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new Error("invalid_target");
    const response = await fetch(target, {
      signal: AbortSignal.timeout(70_000),
      redirect: "error",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (
      ![200, 503].includes(response.status) ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new Error("invalid_response");
    // Bound the response body rather than buffering an unlimited upstream response.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty_body");
    let body = "";
    let size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) throw new Error("oversized_body");
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data = JSON.parse(body);
    if (
      !data ||
      !["operational", "degraded"].includes(data.status) ||
      typeof data.checked_at !== "string" ||
      !Number.isFinite(Date.parse(data.checked_at)) ||
      Math.abs(Date.now() - Date.parse(data.checked_at)) > 5 * 60_000
    )
      throw new Error("invalid_snapshot");
    const result: Snapshot = {
      checked_at: data.checked_at,
      status: data.status,
      backend: component(data.backend),
      database: component(data.database),
      worker: component(data.worker),
      scheduler: component(data.scheduler),
    };
    const healthy = [
      result.backend,
      result.database,
      result.worker,
      result.scheduler,
    ].every((item) => ["up", "not_applicable"].includes(item.status));
    if (
      healthy !== (data.status === "operational") ||
      (response.status === 200) !== healthy ||
      result.backend.status !== "up" ||
      result.database.status === "not_applicable" ||
      result.worker.status === "not_applicable"
    )
      throw new Error("inconsistent_snapshot");
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "probe_failed",
        reason: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return { ...fallback, checked_at: new Date().toISOString() };
  }
}

export async function record(env: Env, scheduledTime: number): Promise<void> {
  const slot = Math.floor(scheduledTime / INTERVAL) * INTERVAL;
  // Skip an already recorded slot; UNIQUE also guards overlapping deliveries.
  if (
    await env.DB.prepare("SELECT slot FROM checks WHERE slot = ?")
      .bind(slot)
      .first()
  )
    return;
  const snapshot = await probe(env.BACKEND_STATUS_URL);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO checks (slot, checked_at, status, payload) VALUES (?, ?, ?, ?)",
    ).bind(slot, Date.now(), snapshot.status, JSON.stringify(snapshot)),
    env.DB.prepare("DELETE FROM checks WHERE slot < ?").bind(
      Date.now() - RETENTION,
    ),
  ]);
  console.log(
    JSON.stringify({ event: "probe_completed", slot, status: snapshot.status }),
  );
}

export function history(
  samples: Pick<Sample, "slot" | "status">[],
  start: number,
  end: number,
) {
  const bySlot = new Map(samples.map((sample) => [sample.slot, sample]));
  const slots: { at: number; status: string }[] = [];
  const first = Math.ceil(start / INTERVAL) * INTERVAL;
  // Exclude the current slot while a scheduled cold-start probe may be in progress.
  for (
    let at = first;
    at < Math.floor(end / INTERVAL) * INTERVAL;
    at += INTERVAL
  )
    slots.push({ at, status: bySlot.get(at)?.status ?? "unknown" });
  const observed = slots.filter((item) => item.status !== "unknown");
  const incidents: { start: number; end: number; status: string }[] = [];
  for (const slot of slots) {
    if (slot.status === "operational" || slot.status === "unknown") continue;
    const last = incidents.at(-1);
    if (last && last.end === slot.at && last.status === slot.status)
      last.end += INTERVAL;
    else
      incidents.push({
        start: slot.at,
        end: slot.at + INTERVAL,
        status: slot.status,
      });
  }
  return {
    slots,
    incidents,
    uptime_percent: observed.length
      ? (observed.filter((item) => item.status === "operational").length /
          observed.length) *
        100
      : null,
    coverage_percent: slots.length ? (observed.length / slots.length) * 100 : 0,
    observed_samples: observed.length,
    expected_samples: slots.length,
  };
}
