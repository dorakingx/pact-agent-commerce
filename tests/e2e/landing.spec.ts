/**
 * Smoke test of what is served today: the landing page of the production build.
 * Product flows get their own specs as their pages land.
 */
import { expect, test } from "@playwright/test";
import { SCENARIOS } from "../../src/lib/domain/scenarios";

test.describe("landing page", () => {
  test("states what PACT does and offers every demo scenario", async ({ page }) => {
    const uncaught: string[] = [];
    page.on("pageerror", (error) => uncaught.push(error.message));

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle("PACT — Programmable Agent Commerce Trust");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("only get paid when the deal is done");
    await expect(page.getByText("Runs on PayPal Sandbox. No real money moves.")).toBeVisible();

    // The cards are generated from the scenario catalogue, so the page and the engine cannot drift apart.
    for (const scenario of SCENARIOS) {
      const card = page.getByRole("link", { name: scenario.title, exact: true });
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("href", `/workspace?scenario=${scenario.id}`);
    }
    expect(uncaught).toEqual([]);
  });

  test("is served with the security headers", async ({ request }) => {
    const response = await request.get("/");
    expect(response.headers()).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    expect(response.headers()).not.toHaveProperty("x-powered-by");
  });

  test("answers an unknown address with the 404 page", async ({ page }) => {
    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("No page is bound to this address");
    await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });
});
