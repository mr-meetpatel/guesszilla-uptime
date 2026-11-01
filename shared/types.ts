export type State = "up" | "down" | "unknown" | "not_applicable";
export type Component = {
  status: State;
  latency_ms?: number | null;
  heartbeat_age_seconds?: number | null;
};
export type Snapshot = {
  checked_at: string;
  status: "operational" | "degraded" | "unavailable";
  backend: Component;
  database: Component;
  worker: Component;
  scheduler: Component;
};
export type Sample = {
  slot: number;
  checked_at: number;
  status: Snapshot["status"];
  payload: string;
};
