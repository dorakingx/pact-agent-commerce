/**
 * Getting around, and what survives a reload, a second browser and a phone-sized screen.
 */
import { NAV_ITEMS } from "../../src/components/shell/nav";
import { expect, test } from "./support/fixtures";
import {
  DEAL_TIMEOUT,
  STEP_TIMEOUT,
  approveInPayPal,
  dealScreen,
  expectNoHorizontalOverflow,
  expectStatus,
  startScenario,
} from "./support/deal";

test.describe.configure({ timeout: 180_000 });

const PHONE = { width: 390, height: 844 };

test("every header link opens its page", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("banner").getByRole("navigation", { name: "Primary" });
  for (const item of NAV_ITEMS) {
    await nav.getByRole("link", { name: item.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${item.href}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).not.toContainText("No page is bound to this address");
    await expect(nav.getByRole("link", { name: item.label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  for (const item of NAV_ITEMS) expect((await page.request.get(item.href)).status(), item.href).toBe(200);
  // /deals has no index of its own and sends the visitor to the workspace.
  await page.goto("/deals");
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole("banner").getByRole("link", { name: "PACT home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("an unknown deal id shows the not-found state", async ({ page, consoleHygiene }) => {
  // The browser reports the API's 404 for the deal itself; that one is expected.
  consoleHygiene.allow(/status of 404/);
  await page.goto("/deals/deal_000000000000");
  const notFound = page.getByTestId("deal-not-found");
  await expect(notFound).toBeVisible();
  await expect(notFound.getByRole("heading", { level: 1 })).toHaveText("Deal not found");
  await notFound.getByRole("link", { name: "Back to the workspace" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
});

test("a deal resumes after a reload, reads as read-only elsewhere, and fits a phone", async ({ page, browser, baseURL, consoleHygiene }) => {
  const dealId = await startScenario(page, "happy-path");

  // Reload in the middle of the negotiation: the page picks the deal up where the server has it.
  await expect(page.getByTestId("negotiation-move").nth(1)).toBeVisible({ timeout: DEAL_TIMEOUT });
  await page.reload();
  await expect(dealScreen(page)).toHaveAttribute("data-deal-id", dealId);
  await expect(page.getByTestId("gate-payment")).toBeVisible({ timeout: DEAL_TIMEOUT });
  await expectStatus(page, "awaiting_payment", STEP_TIMEOUT);

  // Another browser (no shared session) can look, but not drive or decide.
  const other = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  consoleHygiene.watch(other);
  try {
    const visitor = await other.newPage();
    await visitor.goto(`/deals/${dealId}`);
    await expect(visitor.getByTestId("read-only-banner")).toHaveAttribute("data-kind", "other_session");
    await expect(visitor.getByTestId("deal-screen")).toHaveAttribute("data-owner", "false");
    await expect(visitor.getByTestId("deal-screen")).toHaveAttribute("data-status", "awaiting_payment");
    await expect(visitor.getByText("Waiting for the deal's owner to approve the hold in PayPal.")).toBeVisible();
    await expect(visitor.getByTestId("approve-in-paypal")).toHaveCount(0);
    await expect(visitor.getByTestId("cancel-payment")).toHaveCount(0);
    await expect(visitor.getByTestId("auto-run")).toHaveCount(0);
    await expect(visitor.getByTestId("run-next-step")).toHaveCount(0);
    // The buyer agent's mandate (with its private budget ceiling) stays with the owner.
    await expect(visitor.getByTestId("request-intent")).toBeVisible();
    await expect(visitor.getByTestId("mandate-summary")).toHaveCount(0);
    await expect(visitor.getByTestId("mandate-budget")).toHaveCount(0);
  } finally {
    await other.close();
  }

  // The owner finishes the deal on a phone-sized screen; nothing on the way scrolls sideways.
  await page.setViewportSize(PHONE);
  await expectNoHorizontalOverflow(page);
  await approveInPayPal(page, dealId, "$47.00");
  await expectStatus(page, "completed", DEAL_TIMEOUT);
  await expect(page.getByTestId("delivery-tile")).toHaveCount(6);
  await expect(page.getByTestId("outcome-title")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto("/workspace");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("deal-row").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
