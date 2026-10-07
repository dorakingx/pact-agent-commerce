/**
 * Captures the Devpost image gallery (3:2, PNG) from a running PACT deployment.
 *
 *   npx tsx scripts/demo/stills.mts --url https://pact-agent-commerce.vercel.app [--out artifacts/devpost]
 *
 * Runs the "Verified delivery" and "Failed verification" scenarios for real and photographs each
 * stage as it happens. Nothing is mocked: the images show whatever the deployment does.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const BASE = (args.get("url") ?? "http://localhost:3100").replace(/\/$/, "");
const OUT = path.resolve(args.get("out") ?? "artifacts/devpost");
const LONG = 240_000;

async function shoot(page: Page, name: string, target?: Locator, offset = 175): Promise<void> {
  if (target) {
    await target.first().waitFor({ state: "visible", timeout: LONG });
    await target.first().evaluate((el, off) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off }), offset);
  } else {
    await page.evaluate(() => window.scrollTo({ top: 0 }));
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ${name}.png`);
}

async function approveIfAsked(page: Page): Promise<void> {
  const gate = page.getByTestId("approve-in-paypal");
  const moved = page.getByTestId("deal-status").filter({ hasText: /Authorized|Delivered|Verified|Completed|Revision/i });
  const which = await Promise.race([
    gate.waitFor({ timeout: LONG }).then(() => "gate"),
    moved.first().waitFor({ timeout: LONG }).then(() => "auto"),
  ]);
  if (which === "auto") return;
  await gate.click();
  await page.getByRole("button", { name: /Approve simulated hold/ }).click();
  await page.waitForURL(/\/deals\//, { timeout: 60_000 });
}

async function start(page: Page, scenario: string): Promise<void> {
  await page.goto(`${BASE}/workspace?scenario=${scenario}`);
  await page.getByTestId("delegate").click();
  await page.waitForURL(/\/deals\/deal_/, { timeout: 60_000 });
}

mkdirSync(OUT, { recursive: true });
// On failure, keep a picture of what the page showed so a stall can be diagnosed.
process.on("unhandledRejection", async (error) => {
  console.error(error);
  await page?.screenshot({ path: path.join("artifacts/tmp", "stills-failure.png") }).catch(() => undefined);
  process.exit(1);
});
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.5, colorScheme: "light" })).newPage();

await page.goto(BASE);
await shoot(page, "01-landing");

await start(page, "happy-path");
await page.getByTestId("negotiation-result").waitFor({ timeout: LONG });
await shoot(page, "02-negotiation", page.getByTestId("section-negotiation"));
await shoot(page, "03-contract", page.getByTestId("section-contract"));
await approveIfAsked(page);
await page.getByTestId("payment-authorization-id").waitFor({ timeout: LONG });
await shoot(page, "04-authorized", page.getByTestId("section-payment"));
await page.getByTestId("deal-status").filter({ hasText: /Completed/ }).waitFor({ timeout: LONG });
await shoot(page, "05-verification", page.getByTestId("section-verification"));
await shoot(page, "06-captured", page.getByTestId("section-outcome"), 470);

await start(page, "revision");
await approveIfAsked(page);
await page.getByTestId("delivery-missing").first().waitFor({ timeout: LONG });
await shoot(page, "07-failed-verification", page.getByTestId("delivery-missing"), 420);
await page.getByTestId("deal-status").filter({ hasText: /Completed/ }).waitFor({ timeout: LONG });

await page.goto(`${BASE}/operations`);
await page.getByTestId("studio-canvas").waitFor({ timeout: 90_000 });
await page.waitForTimeout(2500);
await shoot(page, "08-operations", page.getByTestId("ops-kpis"), 90);

await browser.close();
