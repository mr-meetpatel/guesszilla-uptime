import "./style.css";
import type { Snapshot } from "../shared/types";

type Status = {
  snapshot: Snapshot | null;
  checked_at: number | null;
  last_success_at: number | null;
  stale: boolean;
};
type History = {
  slots: { at: number; status: string }[];
  incidents: { start: number; end: number; status: string }[];
  uptime_percent: number | null;
  coverage_percent: number;
};
let windowChoice = "24h";
let loading = false;
const get = (id: string) => document.getElementById(id)!;
const date = (value: number | null) =>
  value === null ? "Not recorded yet" : new Date(value).toLocaleString();
const percentage = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(2)}%`;
function text(id: string, value: string) {
  get(id).textContent = value;
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok)
    throw new Error(
      "Monitoring service unavailable. Please try again shortly.",
    );
  return response.json() as Promise<T>;
}

function renderStatus(data: Status) {
  const snapshot = data.snapshot;
  const state = !snapshot ? "pending" : data.stale ? "stale" : snapshot.status;
  get("summary").className = `summary ${state}`;
  text(
    "overall",
    !snapshot
      ? "Waiting for the first check"
      : data.stale
        ? "Monitoring data is stale"
        : snapshot.status === "operational"
          ? "All systems operational"
          : snapshot.status === "degraded"
            ? "Some services need attention"
            : "Backend is unreachable",
  );
  text(
    "freshness",
    `Last check: ${date(data.checked_at)} · Last all-clear: ${date(data.last_success_at)}`,
  );
  get("components").replaceChildren();
  for (const [key, label] of [
    ["backend", "Render backend"],
    ["database", "Supabase database"],
    ["worker", "Background worker"],
    ["scheduler", "Report scheduler"],
  ] as const) {
    const component = snapshot?.[key];
    const card = document.createElement("article");
    card.className = "component";
    const name = document.createElement("h3");
    name.textContent = label;
    const state = document.createElement("p");
    state.className = `state ${data.stale ? "unknown" : (component?.status ?? "unknown")}`;
    state.textContent = data.stale
      ? "Unknown · stale"
      : (component?.status.replace("_", " ") ?? "Unknown");
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = !component
      ? "Awaiting a scheduled observation"
      : key === "database"
        ? component.latency_ms != null
          ? `${component.latency_ms} ms · read-only SELECT 1`
          : "Connectivity checked through the backend"
        : component.heartbeat_age_seconds != null
          ? `Heartbeat ${component.heartbeat_age_seconds}s ago`
          : key === "backend"
            ? "API reachability"
            : "Heartbeat observation";
    card.append(name, state, detail);
    get("components").append(card);
  }
}

function renderHistory(data: History) {
  text("uptime", percentage(data.uptime_percent));
  text("coverage", percentage(data.coverage_percent));
  get("timeline").replaceChildren();
  for (const sample of data.slots) {
    const bar = document.createElement("span");
    bar.className = `sample ${sample.status}`;
    bar.title = `${date(sample.at)} · ${sample.status}`;
    get("timeline").append(bar);
  }
  get("incidents").replaceChildren();
  if (!data.incidents.length) {
    text(
      "incidents",
      data.coverage_percent === 0
        ? "No observations yet. The first scheduled check will appear here."
        : "No incidents in the observed samples.",
    );
  }
  for (const incident of [...data.incidents].reverse()) {
    const row = document.createElement("article");
    row.className = "incident";
    const title = document.createElement("strong");
    title.textContent = incident.status;
    const span = document.createElement("p");
    span.textContent = `${date(incident.start)} – ${date(incident.end)} · sampled interval`;
    row.append(title, span);
    get("incidents").append(row);
  }
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const [status, history] = await Promise.all([
      read<Status>("/api/status"),
      read<History>(`/api/history?window=${windowChoice}`),
    ]);
    renderStatus(status);
    renderHistory(history);
    get("error").hidden = true;
  } catch (error) {
    text(
      "error",
      error instanceof Error ? error.message : "Cannot load monitoring data.",
    );
    get("error").hidden = false;
    text("overall", "Monitoring service unavailable");
    get("summary").className = "summary stale";
    // Avoid displaying an old all-clear after the monitoring API fails.
    get("components").replaceChildren();
    text("freshness", "The most recent displayed history may be outdated.");
  } finally {
    loading = false;
  }
}
document
  .querySelectorAll<HTMLButtonElement>("[data-window]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      if (loading) return;
      windowChoice = button.dataset.window!;
      document
        .querySelectorAll<HTMLButtonElement>("[data-window]")
        .forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)),
        );
      void refresh();
    }),
  );
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  if (!document.hidden) void refresh();
}, 60_000);
void refresh();
