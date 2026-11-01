import { expect, test, type Page } from "@playwright/test";
async function mock(page: Page, state = "operational", stale = false) {
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        snapshot: {
          status: state,
          backend: { status: state === "unavailable" ? "down" : "up" },
          database: {
            status: state === "unavailable" ? "unknown" : "up",
            latency_ms: 10,
          },
          worker: { status: "up" },
          scheduler: { status: "up" },
        },
        checked_at: Date.now(),
        last_success_at: Date.now(),
        stale,
      },
    }),
  );
  await page.route("**/api/history?*", (route) =>
    route.fulfill({
      json: {
        slots: [{ at: Date.now(), status: "operational" }],
        incidents: [],
        uptime_percent: 100,
        coverage_percent: 75,
      },
    }),
  );
}
test("healthy status, history periods and mobile layout", async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("All systems operational")).toBeVisible();
  await expect(page.getByText("100.00%")).toBeVisible();
  const request = page.waitForRequest("**/api/history?window=7d");
  await page.getByRole("button", { name: "7 days" }).click();
  await request;
  await expect(page.getByRole("button", { name: "7 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
});
test("unreachable backend leaves database unknown", async ({ page }) => {
  await mock(page, "unavailable");
  await page.goto("/");
  await expect(page.getByText("Backend is unreachable")).toBeVisible();
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Supabase database" })
      .getByText("unknown", { exact: true }),
  ).toBeVisible();
});
test("stale health never displays green all-clear", async ({ page }) => {
  await mock(page, "operational", true);
  await page.goto("/");
  await expect(page.getByText("Monitoring data is stale")).toBeVisible();
  await expect(page.getByText("All systems operational")).toHaveCount(0);
});
test("first run and monitor outage have distinct messages", async ({
  page,
}) => {
  await mock(page);
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        snapshot: null,
        checked_at: null,
        last_success_at: null,
        stale: true,
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Waiting for the first check")).toBeVisible();
  await page.route("**/api/status", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "monitor_storage_unavailable" },
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByText("Monitoring service unavailable", { exact: true }),
  ).toBeVisible();
});
test("visible page refreshes every minute", async ({ page }) => {
  await page.clock.install();
  await mock(page);
  await page.goto("/");
  await expect(page.getByText("All systems operational")).toBeVisible();
  const refreshed = page.waitForRequest("**/api/status");
  await page.clock.fastForward(60_000);
  await refreshed;
});
