# Wordle uptime

An independent, lightweight public status dashboard for the Wordle Slack bot.
Cloudflare Workers hosts the page and API; a scheduled Worker checks Render every
three minutes and retains one day of samples in Cloudflare D1. Every scheduled
check deletes samples older than 24 hours. No monitoring
history is written to Supabase and no database credentials leave the backend.

## How it works

`Cloudflare cron → Render /health/status → SELECT 1 + heartbeat read → Cloudflare D1`

The browser reads stored results from `/api/status` and `/api/history?window=24h`.
Opening the dashboard does not trigger Render checks. It refreshes every minute
while visible. Results older than ten minutes show as stale. Render timeouts,
invalid responses, and transport errors show the backend as unavailable and the
database as unknown. The monitor allows 70 seconds for a cold start.

History shows sampled availability, not exact continuous uptime. Missing observations
are excluded from uptime calculations and displayed as gaps with a separate coverage
percentage. Incident intervals group consecutive degraded/unavailable samples.
The current three-minute slot is excluded from history until it finishes. A successful
sample means all applicable components were healthy. There are no outbound alerts.

## Local setup

Use the Node version in `.node-version` (22.22.3) and npm:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Set BACKEND_STATUS_URL to your local backend's /health/status URL.
npm run db:local
npm run dev
```

Open the URL printed by Wrangler (normally `http://localhost:8787`). Trigger a local
scheduled check, without waiting three minutes:

```sh
curl 'http://localhost:8787/__scheduled?cron=*/3+*+*+*+*'
curl http://localhost:8787/api/status
```

The backend endpoint must be deployed first from branch `feat/public-health-status`
in the Wordle Slack bot repository. The existing `/health/ready` contract is preserved.
If your backend is not running, the local dashboard still loads and records an
unavailable sample. Local D1 lives in `.wrangler/` and never touches production.

## Checks

```sh
npm run check
npm test                       # actual local D1 via Miniflare; mocked upstream network
npx playwright install chromium
npm run test:e2e                # dashboard states, mobile, history and refresh
npm run build
npx wrangler deploy --dry-run
```

Make equivalents: `make setup dev check test test-e2e build db-local deploy`.
Test data is isolated in Miniflare, with no access to Supabase or live Slack.

## Deploy to Cloudflare

Create a Cloudflare account and enable Workers & Pages and D1. This project is
configured for the free tier; verify current account limits before deploying.

```sh
npx wrangler login
npx wrangler d1 create wordle-uptime
```

Copy the resulting database ID, then export the deployment configuration:

```sh
export CLOUDFLARE_D1_DATABASE_ID='YOUR-DATABASE-UUID'
export BACKEND_STATUS_URL='https://YOUR-SERVICE.onrender.com/health/status'
npm run deploy
```

The deploy script validates configuration, applies D1 migrations, then deploys the
Worker, static assets, and cron trigger. It generates a temporary config without
editing the tracked `wrangler.jsonc`. Alternatively replace its placeholder database
ID and backend URL directly; they are configuration, not credentials.
Your public dashboard is on the `workers.dev` URL printed by Wrangler. Cron triggers
can take several minutes to propagate. The page shows a waiting state until the first
check. Use `npx wrangler tail` for structured monitoring errors and check Cloudflare's
cron invocation metrics if results become stale. Never log raw upstream bodies or tokens.

Create a separate GitHub repository for this folder and push its `main` branch.
CI runs types, unit/integration tests, browser tests, build, and deployment dry-run.
To enable automatic deployment after successful main checks:

- Set repository variable `DEPLOY_ENABLED=true`.
- Create GitHub environment `production`.
- Add secret `CLOUDFLARE_API_TOKEN` with Worker deployment and D1 access.
- Add environment variables `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, and
  `BACKEND_STATUS_URL`.

Protect main with the `checks` job. No Cloudflare account or remote GitHub repository
is provisioned by this source code. Initial cloud deployment requires your credentials.

## Public API

- `GET /api/status`: latest sanitized component snapshot, latest check time, last
  operational time, and stale flag. No samples returns a successful empty response.
- `GET /api/history?window=24h`: time slots, sampled uptime, coverage, and incidents.
- Invalid windows return 400; storage errors return a safe 503. Successful monitoring
  API responses cache for 30 seconds. APIs read D1 only and accept no target URL input.

The only target is configured by the operator. HTTPS is required for deployment;
local development can use HTTP. Upstream redirects are rejected. Seven-day retention
is pruned on scheduled checks, including checks where Render is down. Duplicate cron
deliveries cannot create duplicate samples. Browser data is rendered as text, not HTML.

Monitoring can reduce inactivity but does not guarantee free-tier uptime or automatically
resume a paused Supabase project. If Render is down, database health is unknown because
it is checked through Render. Review the services' policies and usage limits.

References: [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[D1](https://developers.cloudflare.com/d1/), [Render Free](https://render.com/docs/free).
