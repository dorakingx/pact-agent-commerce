/**
 * Steps a person takes on the deal screens, and the waits that go with them. Every wait is on
 * visible state (a status the page renders, a figure, a gate); none is a fixed sleep.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type { AdvanceResponse, DealResponse, DealView } from "../../../src/lib/api/dto";
import type { ScenarioId } from "../../../src/lib/domain/scenarios";
import type { DealStatus } from "../../../src/lib/domain/status";
import { expect } from "./fixtures";

/**
 * A whole scripted deal runs in about fifteen steps with a 600 ms beat between them: ten seconds
 * on an idle machine. The ceilings are generous so a busy CI runner slows the suite down rather
 * than failing it; no test waits for them unless something is wrong.
 */
export const DEAL_TIMEOUT = 90_000;
/** One step, or a page settling after a navigation. */
export const STEP_TIMEOUT = 15_000;

export function dealScreen(page: Page): Locator {
  return page.getByTestId("deal-screen");
}

/** Waits until the deal page renders `status` (the server's status, mirrored on the screen's root). */
export async function expectStatus(page: Page, status: DealStatus | RegExp, timeout = DEAL_TIMEOUT): Promise<void> {
  await expect(dealScreen(page)).toHaveAttribute("data-status", status, { timeout });
}

/** Opens the workspace on a scenario, checks the composer was filled from it, and delegates. Returns the deal id. */
export async function startScenario(page: Page, scenarioId: ScenarioId, intent?: string): Promise<string> {
  await page.goto(`/workspace?scenario=${scenarioId}`);
  await expect(page.getByTestId("composer-scenario")).toHaveAttribute("data-scenario-id", scenarioId);
  if (intent !== undefined) await expect(page.getByTestId("intent-input")).toHaveValue(intent);
  const delegate = page.getByTestId("delegate");
  await expect(delegate).toBeEnabled();
  await delegate.click();
  await expect(page).toHaveURL(/\/deals\/deal_[^/?]+$/, { timeout: STEP_TIMEOUT });
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  await expect(dealScreen(page)).toHaveAttribute("data-deal-id", id, { timeout: STEP_TIMEOUT });
  return id;
}

/** The two compact figures in the sticky bar, in minor units. */
export async function expectFunds(page: Page, heldMinor: number, capturedMinor: number, timeout = STEP_TIMEOUT): Promise<void> {
  await expect(page.getByTestId("funds-held")).toHaveAttribute("data-amount-minor", String(heldMinor), { timeout });
  await expect(page.getByTestId("funds-captured")).toHaveAttribute("data-amount-minor", String(capturedMinor), { timeout });
}

/**
 * Holds every advance request the page sends until the returned function is called, so a test
 * can look at a state the runner would otherwise leave after one beat. The page's own runner is
 * untouched: its request simply takes longer to answer.
 */
export async function holdAdvances(page: Page): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pattern = "**/api/deals/*/advance";
  const handler = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    await released;
    // The page may have navigated away while the request was held.
    await route.continue().catch(() => undefined);
  };
  await page.route(pattern, handler);
  return async () => {
    release();
    await page.unroute(pattern, handler);
  };
}

/**
 * From the payment gate: "Approve in PayPal", approve on the simulated approval page, and land
 * back on the deal.
 */
export async function approveInPayPal(page: Page, dealId: string, priceText: string): Promise<void> {
  const gate = page.getByTestId("gate-payment");
  await expect(gate).toBeVisible({ timeout: DEAL_TIMEOUT });
  await expect(page.getByTestId("payment-status")).toBeVisible();
  await gate.getByTestId("approve-in-paypal").click();

  await expect(page).toHaveURL(/\/pay\/simulated\/[^/?]+$/, { timeout: STEP_TIMEOUT });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Simulated PayPal approval");
  await expect(page.getByText(priceText, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve simulated hold" }).click();

  await expect(page).toHaveURL((url) => url.pathname === `/deals/${dealId}`, { timeout: STEP_TIMEOUT });
  await expect(dealScreen(page)).toHaveAttribute("data-deal-id", dealId, { timeout: STEP_TIMEOUT });
}

/** The latest verification report on the page (the one expanded by default). */
export function latestReport(page: Page): Locator {
  return page.getByTestId("verification-report").last();
}

/** Fails if the page can be scrolled sideways. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1)
      .filter((element) => getComputedStyle(element).position !== "fixed")
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}${element.dataset.testid ? `[${element.dataset.testid}]` : ""}.${[...element.classList].slice(0, 3).join(".")}`);
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, wide };
  });
  expect(overflow.scrollWidth, `the page scrolls sideways; widest elements: ${overflow.wide.join(", ")}`).toBeLessThanOrEqual(overflow.clientWidth);
}

/* ------------------------------------------------------------------------------------------ */
/* The same deal driven over HTTP, with the browser's own cookie jar (for set-up, not for UI). */

const SAME_ORIGIN_HEADERS = (baseURL: string) => ({ origin: baseURL, "sec-fetch-site": "same-origin" });

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

/**
 * Creates a deal in the page's session and drives it until `stop` holds, approving at the
 * spending gate and on the simulated approval page, releasing at a review gate.
 */
export async function driveOverHttp(
  page: Page,
  baseURL: string,
  scenarioId: ScenarioId,
  stop: (deal: DealView) => boolean = (deal) => deal.next.kind === "done",
): Promise<DealView> {
  const request = page.request;
  const headers = SAME_ORIGIN_HEADERS(baseURL);
  const created = await request.post("/api/deals", { headers, data: { intent: "", scenarioId, tzOffsetMinutes: 0 } });
  let deal = (await ok<DealResponse>(created)).deal;
  for (let turn = 0; turn < 60 && !stop(deal); turn += 1) {
    if (deal.next.kind === "auto") {
      deal = (await ok<AdvanceResponse>(await request.post(`/api/deals/${deal.id}/advance`, { headers, data: {} }))).deal;
    } else if (deal.next.kind === "human" && deal.next.gate === "payment") {
      await ok(await request.post("/api/simulated/approve", { headers, data: { orderId: deal.payment?.orderId } }));
      deal = (await ok<DealResponse>(await request.get(`/api/deals/${deal.id}`))).deal;
    } else if (deal.next.kind === "human") {
      const kind = deal.next.gate === "approval" ? "approve_spend" : "release_payment";
      deal = (await ok<DealResponse>(await request.post(`/api/deals/${deal.id}/decision`, { headers, data: { kind } }))).deal;
    } else {
      break;
    }
  }
  expect(stop(deal), `the deal stopped at "${deal.status}"`).toBe(true);
  return deal;
}
