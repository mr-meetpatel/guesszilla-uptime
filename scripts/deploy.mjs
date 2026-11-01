import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseWranglerConfig } from "./wrangler-config.mjs";
const configSource = await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);
const config = parseWranglerConfig(configSource);
const database =
  process.env.CLOUDFLARE_D1_DATABASE_ID || config.d1_databases[0].database_id;
const target = process.env.BACKEND_STATUS_URL || config.vars.BACKEND_STATUS_URL;
if (
  !/^[a-f0-9-]{36}$/i.test(database) ||
  database.startsWith("00000000") ||
  target.includes("YOUR-SERVICE")
)
  throw new Error(
    "Configure CLOUDFLARE_D1_DATABASE_ID and BACKEND_STATUS_URL before deployment.",
  );
const url = new URL(target);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/health/status"
)
  throw new Error(
    "BACKEND_STATUS_URL must be an HTTPS /health/status URL without credentials.",
  );
config.d1_databases[0].database_id = database;
config.vars.BACKEND_STATUS_URL = target;
const file = ".deploy.wrangler.json";
try {
  await writeFile(file, JSON.stringify(config));
  for (const args of [
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "wordle-uptime",
      "--remote",
      "--config",
      file,
    ],
    ["wrangler", "deploy", "--config", file],
  ]) {
    const result = spawnSync("npx", args, {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        "Cloudflare deployment failed. Check the command output.",
      );
  }
} finally {
  await unlink(file).catch(() => undefined);
}
