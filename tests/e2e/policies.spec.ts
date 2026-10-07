/**
 * /policies: the spending policy and its live "what would happen" preview, and the delegated
 * agent wallet — each checked by the deal that follows it.
 */
import { expect, test } from "./support/fixtures";
import { DEAL_TIMEOUT, STEP_TIMEOUT, dealScreen, expectFunds, expectStatus, startScenario } from "./support/deal";

test.describe.configure({ timeout: 180_000 });

test("a lower autonomous limit is previewed before saving and stops the next deal at the approval gate", async ({ page }) => {
  await page.goto("/policies");
  await expect(page.getByTestId("policy-form")).toBeVisible();
  const limit = page.getByTestId("policy-autonomous-limit");
  await expect(limit).toHaveValue("100.00");
  await expect(page.getByTestId("policy-save-state")).toHaveAttribute("data-state", "default");

  // The $47 example passes under the default $100 limit…
  const example = page.getByTestId("policy-preview-established-illustration");
  await expect(example).toHaveAttribute("data-outcome", "allow");

  // …and needs approval the moment the limit drops below it, before anything is saved.
  await limit.fill("40");
  await expect(example).toHaveAttribute("data-outcome", "needs_approval");
  await expect(page.getByTestId("policy-preview-new-seller")).toHaveAttribute("data-outcome", "needs_approval");
  await expect(page.getByTestId("policy-save-state")).toHaveAttribute("data-state", "unsaved");
  // A limit that cannot be read leaves the preview waiting rather than guessing.
  await limit.fill("forty");
  await expect(page.getByTestId("policy-save-state")).toHaveAttribute("data-state", "invalid");
  await expect(example).toHaveAttribute("data-outcome", "unknown");
  await limit.fill("40");
  await expect(example).toHaveAttribute("data-outcome", "needs_approval");

  await page.getByTestId("policy-save").click();
  await expect(page.getByTestId("policy-save-state")).toHaveAttribute("data-state", "saved");
  await expect(limit).toHaveValue("40.00");
  await expect(page.getByText("Policy saved")).toBeVisible();

  // The saved policy survives a reload and is what the workspace shows.
  await page.reload();
  await expect(page.getByTestId("policy-autonomous-limit")).toHaveValue("40.00");
  await expect(page.getByTestId("policy-preview-established-illustration")).toHaveAttribute("data-outcome", "needs_approval");

  await startScenario(page, "happy-path");
  const gate = page.getByTestId("gate-approval");
  await expect(gate).toBeVisible({ timeout: DEAL_TIMEOUT });
  await expectStatus(page, "awaiting_approval", STEP_TIMEOUT);
  await expect(page.locator('[data-testid="policy-check"][data-check-id="autonomous_limit"]')).toHaveAttribute("data-outcome", "needs_approval");
  await expect(gate).toContainText("$47.00");
  await expect(page.getByTestId("section-payment")).toHaveCount(0);
  await expectFunds(page, 0, 0);
});

test("a connected agent wallet authorizes an in-policy deal with no approval page", async ({ page }) => {
  await page.goto("/policies");
  const wallet = page.getByTestId("wallet-card");
  await expect(wallet.getByTestId("wallet-status")).toHaveAttribute("data-state", "interactive");
  await expect(wallet.getByTestId("wallet-provider")).toContainText(/simulated/i);

  await wallet.getByTestId("wallet-connect").click();
  // The simulated consent completes at once and returns here.
  await expect(page).toHaveURL(/\/policies/, { timeout: STEP_TIMEOUT });
  await expect(wallet.getByTestId("wallet-status")).toHaveAttribute("data-state", "connected", { timeout: STEP_TIMEOUT });
  await expect(wallet.getByTestId("wallet-disconnect")).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]wallet=/);

  await page.goto("/workspace");
  await expect(page.getByTestId("context-wallet")).toHaveAttribute("data-value", "delegated");
  await expect(page.getByTestId("context-wallet")).toContainText("Agent wallet connected");

  // No payment gate and no trip to an approval page: the deal runs straight through to capture.
  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await startScenario(page, "happy-path");
  await expectStatus(page, "completed", DEAL_TIMEOUT);
  await expect(page.getByTestId("section-payment")).toContainText("Delegated agent wallet");
  await expect(page.getByTestId("gate-payment")).toHaveCount(0);
  await expectFunds(page, 0, 4700);
  await expect(page.getByTestId("outcome-title")).toHaveText("Captured $47.00");
  await expect(dealScreen(page)).toHaveAttribute("data-next", "done");
  expect(visited.filter((path) => path.startsWith("/pay/"))).toEqual([]);
});
