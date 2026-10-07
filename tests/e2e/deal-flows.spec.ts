/**
 * The four demo scenarios, driven through the product UI the way a presenter drives them:
 * workspace → live deal → simulated PayPal approval → back → verification → outcome.
 *
 * The server runs scripted agents and the labelled payment simulator (playwright.config.ts), so
 * prices, rounds and decisions are exact: happy-path $47.00, revision $27.00, approval $180.00,
 * injection $18.00.
 */
import { SCENARIOS, type ScenarioId } from "../../src/lib/domain/scenarios";
import { expect, test } from "./support/fixtures";
import {
  DEAL_TIMEOUT,
  STEP_TIMEOUT,
  approveInPayPal,
  dealScreen,
  expectFunds,
  expectStatus,
  holdAdvances,
  latestReport,
  startScenario,
} from "./support/deal";

test.describe.configure({ timeout: 180_000 });

const intentOf = (id: ScenarioId): string => SCENARIOS.find((scenario) => scenario.id === id)?.intent ?? "";

test.describe("with motion", () => {
  // The one walk-through that keeps every transition on (see `reducedMotion` in playwright.config.ts).
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("verified delivery: negotiate, sign, hold, deliver, verify, capture", async ({ page }) => {
    const dealId = await startScenario(page, "happy-path", intentOf("happy-path"));
    await expect(page.getByTestId("deal-seller")).toHaveAttribute("data-seller-id", "northwind");

    // Negotiation: the agents trade at least four moves and agree.
    const negotiation = page.getByTestId("section-negotiation");
    await expect(negotiation.getByTestId("negotiation-result")).toHaveAttribute("data-status", "agreed", { timeout: DEAL_TIMEOUT });
    expect(await negotiation.getByTestId("negotiation-move").count()).toBeGreaterThanOrEqual(4);
    await expect(negotiation.getByTestId("negotiation-result")).toContainText("Agreed at $47.00");

    // The contract and its terms hash, then the policy passes on its own.
    await expect(page.getByTestId("contract-hash")).toBeVisible({ timeout: DEAL_TIMEOUT });
    await expect(page.getByTestId("contract-price")).toContainText("$47.00");
    await expect(page.getByTestId("policy-outcome")).toHaveAttribute("data-outcome", "allow");
    await expect(page.getByTestId("gate-approval")).toHaveCount(0);

    // Nothing is held until the payer approves. The approval returns to a deal whose money is held,
    // not captured: the runner's next step is held back for that one look, then let go. (At the
    // payment gate the runner sends nothing, so holding from here changes nothing before it.)
    await expect(page.getByTestId("gate-payment")).toBeVisible({ timeout: DEAL_TIMEOUT });
    await expectFunds(page, 0, 0);
    const release = await holdAdvances(page);
    await approveInPayPal(page, dealId, "$47.00");
    await expect(page.getByText("Approval received — funds are held")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/deals/${dealId}$`));
    await expectStatus(page, "authorized", STEP_TIMEOUT);
    await expectFunds(page, 4700, 0);
    await expect(page.getByTestId("funds-held")).toContainText("$47.00");
    await expect(page.getByTestId("funds-captured")).toContainText("$0.00");
    await expect(page.getByTestId("payment-status")).toContainText(/authorized/i);
    await release();

    // Delivery: three illustrations, each in 16:9 and 1:1.
    const delivery = page.getByTestId("section-delivery");
    await expect(delivery.getByTestId("delivery-tile")).toHaveCount(6, { timeout: DEAL_TIMEOUT });
    await expect(delivery.getByTestId("delivery-missing")).toHaveCount(0);

    // Verification: every condition passes, then PACT captures exactly the contract price.
    const report = latestReport(page);
    await expect(report).toHaveAttribute("data-decision", "capture_eligible", { timeout: DEAL_TIMEOUT });
    await expect(report.getByTestId("verification-check")).toHaveCount(6);
    await expect(report.locator('[data-testid="verification-check"]:not([data-result="pass"])')).toHaveCount(0);
    await expect(report.getByTestId("verification-banner")).toContainText("All conditions verified");

    await expectStatus(page, "completed");
    await expectFunds(page, 0, 4700);
    await expect(page.getByTestId("funds-captured")).toContainText("$47.00");
    await expect(page.getByTestId("outcome-title")).toHaveText("Captured $47.00");
    await expect(page.getByTestId("outcome-capture-id")).toBeVisible();
    await expect(page.getByTestId("audit-chain")).toHaveAttribute("data-valid", "true");
    await expect(page.getByTestId("audit-chain")).toContainText("Hash-chained · verified");
    expect(await page.getByTestId("audit-event").count()).toBeGreaterThan(10);

    await page.getByTestId("start-another").click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByTestId("deal-row").first()).toBeVisible();
  });
});

test("failed verification: a missing 1:1 version holds the money until the revision passes", async ({ page }) => {
  const dealId = await startScenario(page, "revision", intentOf("revision"));
  await expect(page.getByTestId("gate-payment")).toBeVisible({ timeout: DEAL_TIMEOUT });

  // The presenter takes over pacing: with auto-run off, one click runs one step.
  const autoRun = page.getByTestId("auto-run");
  await autoRun.click();
  await expect(autoRun).toHaveAttribute("aria-checked", "false");
  await approveInPayPal(page, dealId, "$27.00");
  await expect(page.getByTestId("auto-run")).toHaveAttribute("aria-checked", "false");
  await expectStatus(page, "authorized", STEP_TIMEOUT);

  const runNext = page.getByTestId("run-next-step");
  for (const status of ["submitted", "revision_required"] as const) {
    await expect(runNext).toBeEnabled();
    await runNext.click();
    await expectStatus(page, status, STEP_TIMEOUT);
  }

  // The first report fails on the missing 1:1 of illustration #2, the delivery shows the gap,
  // and nothing has been captured.
  const first = page.locator('[data-testid="verification-report"][data-round="1"]');
  await expect(first).toHaveAttribute("data-decision", "revision_required");
  const failed = first.locator('[data-testid="verification-check"][data-result="fail"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.getByTestId("check-result")).toHaveText(/fail/i);
  await expect(failed.getByTestId("check-evidence")).toContainText("1:1");
  await expect(failed.getByTestId("check-evidence")).toContainText("illustration #2");
  await expect(first.getByTestId("verification-banner")).toContainText("Not captured");

  const missing = page.getByTestId("section-delivery").getByTestId("delivery-missing");
  await expect(missing).toHaveCount(1);
  await expect(missing).toContainText("1:1 — not delivered");
  await expectFunds(page, 2700, 0);
  await expect(page.getByTestId("funds-captured")).toContainText("$0.00");

  // Auto-run back on: the seller revises, the second round passes, PACT captures.
  await autoRun.click();
  await expect(autoRun).toHaveAttribute("aria-checked", "true");
  await expectStatus(page, "completed");
  await expect(page.getByTestId("verification-report")).toHaveCount(2);
  await expect(latestReport(page)).toHaveAttribute("data-decision", "capture_eligible");
  await expect(page.getByTestId("delivery-tab")).toHaveCount(2);
  await expect(page.getByTestId("section-delivery").getByTestId("delivery-missing")).toHaveCount(0);
  await expectFunds(page, 0, 2700);
  await expect(page.getByTestId("outcome-title")).toHaveText("Captured $27.00");
});

test.describe("human approval", () => {
  test("a price above the autonomous limit waits for a person, then completes once approved", async ({ page }) => {
    const dealId = await startScenario(page, "approval", intentOf("approval"));

    const gate = page.getByTestId("gate-approval");
    await expect(gate).toBeVisible({ timeout: DEAL_TIMEOUT });
    await expect(gate).toContainText("Human approval required");
    await expect(gate).toContainText("$180.00");
    await expectStatus(page, "awaiting_approval", STEP_TIMEOUT);
    await expect(page.locator('[data-testid="policy-check"][data-check-id="autonomous_limit"]')).toHaveAttribute("data-outcome", "needs_approval");
    // No payment exists yet: no payment section, nothing held.
    await expect(page.getByTestId("section-payment")).toHaveCount(0);
    await expectFunds(page, 0, 0);

    await gate.getByTestId("approve-spend").click();
    await expect(page.getByTestId("approval-record")).toBeVisible({ timeout: STEP_TIMEOUT });
    await approveInPayPal(page, dealId, "$180.00");

    await expectStatus(page, "completed");
    await expectFunds(page, 0, 18000);
    await expect(page.getByTestId("outcome-title")).toHaveText("Captured $180.00");
    await expect(page.getByTestId("audit-chain")).toHaveAttribute("data-valid", "true");
  });

  test("declining ends the deal before any payment is created", async ({ page }) => {
    await startScenario(page, "approval");
    const gate = page.getByTestId("gate-approval");
    await expect(gate).toBeVisible({ timeout: DEAL_TIMEOUT });

    await gate.getByTestId("decline-spend").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Decline this spend?");
    await dialog.getByTestId("decline-spend-confirm").click();
    await expect(dialog).toHaveCount(0);

    await expectStatus(page, "declined", STEP_TIMEOUT);
    await expect(page.getByTestId("outcome-title")).toHaveText("Spend declined — no payment was created");
    await expect(page.getByTestId("gate-approval")).toHaveCount(0);
    await expect(page.getByTestId("section-payment")).toHaveCount(0);
    await expectFunds(page, 0, 0);
    await expect(dealScreen(page)).toHaveAttribute("data-next", "done");
  });
});

test("hostile delivery: hidden instructions go to a person, and rejecting voids the hold", async ({ page }) => {
  const dealId = await startScenario(page, "injection", intentOf("injection"));
  await expect(page.getByTestId("demo-fault-badge").first()).toBeVisible();

  // A new seller: the first spend needs approval.
  const approval = page.getByTestId("gate-approval");
  await expect(approval).toBeVisible({ timeout: DEAL_TIMEOUT });
  await expect(page.locator('[data-testid="policy-check"][data-check-id="seller_trust"]')).toHaveAttribute("data-outcome", "needs_approval");
  await approval.getByTestId("approve-spend").click();
  await approveInPayPal(page, dealId, "$18.00");

  // The verifier flags the hidden instructions; PACT stops for a human with the money held.
  const review = page.getByTestId("gate-review");
  await expect(review).toBeVisible({ timeout: DEAL_TIMEOUT });
  await expectStatus(page, "in_review", STEP_TIMEOUT);
  const report = latestReport(page);
  await expect(report).toHaveAttribute("data-decision", "human_review");
  await expect(report.locator('[data-testid="verification-check"][data-rule-id="R6"]')).toHaveAttribute("data-result", "fail");
  await expectFunds(page, 1800, 0);

  await review.getByTestId("reject-delivery").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Reject the delivery and void the hold?");
  await dialog.getByTestId("reject-delivery-confirm").click();

  await expectStatus(page, "rejected");
  await expect(page.getByTestId("outcome-title")).toHaveText("Authorization voided — nothing was captured");
  await expect(page.getByTestId("payment-status")).toContainText(/voided/i);
  await expect(page.getByTestId("funds-captured")).toHaveAttribute("data-amount-minor", "0");
  await expect(page.getByTestId("funds-captured")).toContainText("$0.00");
  await expect(page.getByTestId("review-record")).toHaveAttribute("data-type", "human.rejected_delivery");
  await expect(page.getByTestId("audit-chain")).toHaveAttribute("data-valid", "true");
});
