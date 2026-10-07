/**
 * /operations against this browser's own deals: the KPI strip, the AG Grid ledger (quick filter,
 * inspector, CSV export) and the AG Studio dashboard.
 *
 * The deals are set up over HTTP with the page's own cookie jar — the same session the page then
 * reads — because what is under test here is the operations view, not the deal screen.
 */
import { readFile } from "node:fs/promises";
import { expect, test } from "./support/fixtures";
import { driveOverHttp } from "./support/deal";

test.describe.configure({ timeout: 150_000 });

test("the ledger and the dashboard show the session's deals", async ({ page, baseURL }) => {
  const captured = await driveOverHttp(page, baseURL ?? "", "happy-path");
  const waiting = await driveOverHttp(page, baseURL ?? "", "approval", (deal) => deal.status === "awaiting_approval");

  await page.goto("/operations");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // KPI strip: both deals, and exactly the captured one's money.
  const kpis = page.getByTestId("ops-kpis");
  await expect(kpis).toBeVisible();
  await expect(page.getByTestId("ops-kpi-deals")).toContainText("2");
  await expect(page.getByTestId("ops-kpi-captured")).toContainText("$47.00");
  await expect(page.getByTestId("ops-kpi-review")).toContainText("1");

  // Ledger (AG Grid): both rows, then the quick filter narrows them.
  await page.getByTestId("ops-tab-ledger").click();
  await expect(page).toHaveURL(/[?&]view=ledger/);
  const ledger = page.getByTestId("ops-panel-ledger");
  const grid = ledger.getByTestId("ledger-grid");
  const codeLink = (code: string) => page.getByTestId("ledger-deal-link").filter({ hasText: code });
  const link = (code: string) => grid.getByTestId("ledger-deal-link").filter({ hasText: code });
  await expect(link(captured.code)).toBeVisible({ timeout: 15_000 });
  await expect(link(waiting.code)).toBeVisible();
  await expect(ledger.getByTestId("ledger-count")).toHaveText("2 deals");

  const search = ledger.getByTestId("ledger-search");
  await search.fill(captured.code);
  await expect(ledger.getByTestId("ledger-count")).toHaveText("Showing 1 of 2 deals");
  await expect(link(captured.code)).toBeVisible();
  await expect(link(waiting.code)).toHaveCount(0);
  await search.fill("no deal is called this");
  await expect(ledger.getByTestId("ledger-no-match")).toBeVisible();
  await expect(grid.getByTestId("ledger-deal-link")).toHaveCount(0);
  await search.fill("");
  await expect(ledger.getByTestId("ledger-count")).toHaveText("2 deals");
  await expect(link(waiting.code)).toBeVisible();

  // Inspector: a click on the row (not on the code link) opens the contract and verification facts.
  // AG Grid draws a row once per column section (pinned and scrolling), joined by its row id.
  const rowId = await grid.locator(".ag-row").filter({ has: codeLink(captured.code) }).first().getAttribute("row-id");
  expect(rowId).toBeTruthy();
  await grid.locator(`.ag-row[row-id="${rowId}"] [col-id="title"]`).click();
  const inspector = page.getByTestId("deal-inspector");
  await expect(inspector).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]deal=${captured.id}`));
  await expect(inspector.getByTestId("inspector-status")).toContainText(/completed|captured/i);
  await expect(inspector.getByTestId("inspector-captured")).toContainText("$47.00");
  await expect(inspector.getByTestId("inspector-contract")).toBeVisible({ timeout: 15_000 });
  await expect(inspector.getByTestId("inspector-price")).toContainText("$47.00");
  const contract = inspector.getByTestId("inspector-contract");
  await expect(contract).toContainText("Northwind Studio");
  await expect(contract).toContainText("3 illustrations · 16:9 and 1:1");
  await expect(contract).toContainText("Terms hash");
  const verification = inspector.getByTestId("inspector-verification");
  await expect(verification.getByTestId("inspector-decision")).toBeVisible();
  await expect(verification.getByTestId("inspector-condition")).toHaveCount(6);
  await expect(verification.locator('[data-testid="inspector-condition"]:not([data-result="pass"])')).toHaveCount(0);
  await expect(inspector.getByTestId("inspector-open-deal")).toHaveAttribute("href", `/deals/${captured.id}`);
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]deal=/);

  // CSV export: a file named for today, holding both deals.
  const download = page.waitForEvent("download");
  await ledger.getByTestId("ledger-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^pact-ledger-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await file.path(), "utf8");
  expect(csv).toContain(captured.code);
  expect(csv).toContain(waiting.code);

  // Dashboard (AG Studio): mounts and draws at least one widget.
  await page.getByTestId("ops-tab-dashboard").click();
  const dashboard = page.getByTestId("ops-panel-dashboard");
  await expect(dashboard.getByTestId("studio-dashboard")).toBeVisible({ timeout: 20_000 });
  await expect(dashboard.getByTestId("studio-error")).toHaveCount(0);
  const canvas = dashboard.getByTestId("studio-canvas");
  await expect(canvas.locator('[data-testid="settlement-rail"], [data-testid="review-queue"], [data-testid="verdict-card"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(canvas.getByTestId("review-queue-item").filter({ hasText: waiting.code })).toBeVisible();
});

test("an empty session is pointed at the workspace", async ({ page }) => {
  await page.goto("/operations");
  await expect(page.getByTestId("ops-empty")).toBeVisible();
  await page.getByTestId("ops-empty-workspace").click();
  await expect(page).toHaveURL(/\/workspace$/);
});
