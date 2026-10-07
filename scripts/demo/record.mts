/**
 * Records the demo video described in docs/demo-script.md.
 *
 *   npx tsx scripts/demo/record.mts --url https://pact-agent-commerce.vercel.app [--out artifacts/devpost]
 *
 * 1. Drives the real product in Chromium at 1920x1080 (Playwright video), following the storyboard.
 *    Captions and title cards are drawn into the page, so they are part of the recording.
 * 2. Marks every scene and every wait (model latency, PayPal round trips) on a timeline.
 * 3. Synthesises the narration with macOS `say`, then uses ffmpeg to play "show" segments at real
 *    speed and fast-forward "wait" segments so each scene matches its narration. Nothing is staged:
 *    every frame is the live product, only waiting time is compressed.
 *
 * Requires macOS (`say`), ffmpeg on PATH and a Playwright Chromium.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i].replace(/^--/, "");
  const value = process.argv[i + 1];
  if (value !== undefined && !value.startsWith("--")) {
    args.set(key, value);
    i += 1;
  } else {
    args.set(key, "");
  }
}
const BASE = (args.get("url") ?? "http://localhost:3100").replace(/\/$/, "");
const OUT = path.resolve(args.get("out") ?? "artifacts/devpost");
const WORK = path.resolve("artifacts/tmp/demo");
const VOICE = args.get("voice") ?? "Samantha";
const SIZE = { width: 1920, height: 1080 };
/** The page is laid out at 1440x810 and scaled up to 1080p, so text stays legible in the video. */
const VIEWPORT = { width: 1440, height: 810 };

interface Segment {
  scene: number;
  kind: "show" | "wait";
  from: number;
  to: number;
}

const NARRATION: readonly string[] = [
  "AI agents can negotiate and do the work. But who decides when they deserve to get paid? Today it's a human, or the agent itself. PACT makes payment a consequence of verified delivery.",
  "I give my buyer agent a task and a budget, in plain language. That budget becomes a hard ceiling the agent cannot cross.",
  "The buyer agent negotiates with a seller agent running on a different model. They trade price against deadline and revisions. A rules engine clamps every offer: the models can propose, but they can't break their limits.",
  "The agreed terms compile into a machine-readable contract with its own verification rules, and a hash. PACT creates a PayPal order carrying that hash and authorizes it. The money is held, not captured.",
  "The seller delivers. Every contract condition is checked: counts and real aspect ratios by code, the brief by an AI verifier that looks at the images. Each one has evidence and a confidence. All six pass, and only now does PACT capture the payment.",
  "Now a seller that cuts corners. One required file is missing. The verifier names exactly what failed, and nothing is captured. The seller revises, PACT verifies again, and only then releases the payment.",
  "Autonomy has a ceiling. Above the limit I set, the agent stops and asks. And when a seller hides instructions for the verifier inside its file, PACT flags it, a human rejects it, and the authorization is voided.",
  "Operations shows every contract: what's held, what's captured, what failed and why. It's built on AG Studio, with an auditor agent that can explain any deal and reconcile it with PayPal, but can't move a cent.",
  "PACT. Trust infrastructure for the agent economy.",
];

const CAPTIONS: readonly string[] = [
  "Who decides when an AI agent deserves to get paid?",
  "A human delegates a task — the budget is a hard ceiling",
  "Two agents on different models negotiate · a rules engine bounds every offer",
  "Hashed contract → PayPal authorization · funds held, not captured",
  "Every condition verified with evidence → only then PayPal captures",
  "A required file is missing → nothing captured → revision → captured",
  "Above the limit, the agent asks · hidden instructions → voided",
  "AG Studio operations · an auditor agent that can't move money",
  "",
];

/* ------------------------------------------------------------------ recording */

let t0 = 0;
let scene = -1;
const segments: Segment[] = [];
let open: Segment | null = null;
const now = () => (Date.now() - t0) / 1000;

function mark(kind: Segment["kind"]): void {
  const t = now();
  if (open) open.to = t;
  open = { scene, kind, from: t, to: t };
  segments.push(open);
}

function startScene(index: number): void {
  scene = index;
  mark("show");
}

/** Run a wait (model latency, PayPal) as a fast-forwardable segment. */
async function waiting<T>(fn: () => Promise<T>): Promise<T> {
  mark("wait");
  try {
    return await fn();
  } finally {
    mark("show");
  }
}

async function hold(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    let el = document.getElementById("pact-demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "pact-demo-caption";
      el.setAttribute(
        "style",
        "position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:2147483647;max-width:1040px;" +
          "padding:14px 26px;border-radius:12px;background:rgba(11,18,32,.92);color:#fff;font:600 22px/1.35 var(--font-geist-sans,system-ui);" +
          "letter-spacing:-.01em;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.25);pointer-events:none;transition:opacity .25s",
      );
      document.body.appendChild(el);
    }
    el.textContent = value;
    el.style.opacity = value ? "1" : "0";
  }, text);
}

async function titleCard(page: Page, title: string, subtitle: string, footer = ""): Promise<void> {
  await page.evaluate(
    ([t, s, f]) => {
      const el = document.createElement("div");
      el.id = "pact-demo-title";
      el.setAttribute(
        "style",
        "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;" +
          "background:#0B1220;color:#fff;font-family:var(--font-geist-sans,system-ui);transition:opacity .4s",
      );
      el.innerHTML =
        `<div style="font:700 92px/1 var(--font-geist-sans,system-ui);letter-spacing:-.04em">${t}</div>` +
        `<div style="font:500 30px/1.3 var(--font-geist-sans,system-ui);color:#A7F3D0;max-width:1300px;text-align:center">${s}</div>` +
        (f ? `<div style="margin-top:28px;font:500 19px/1 var(--font-geist-mono,monospace);color:#94A3B8">${f}</div>` : "");
      document.body.appendChild(el);
    },
    [title, subtitle, footer],
  );
}

async function clearTitle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById("pact-demo-title");
    if (el) el.remove();
  });
}

async function show(page: Page, target: Locator, offset = 150): Promise<void> {
  await target.first().waitFor({ state: "visible" });
  await target.first().evaluate((el, off) => {
    const y = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }, offset);
  await page.waitForTimeout(900);
}

const status = (page: Page) => page.getByTestId("deal-status");

async function waitForStatus(page: Page, pattern: RegExp, timeout = 240_000): Promise<void> {
  await waiting(() => status(page).filter({ hasText: pattern }).first().waitFor({ timeout }));
}

/** Interactive approval only happens without a delegated wallet (local simulator). Production uses the wallet. */
async function passPaymentGate(page: Page): Promise<void> {
  const gate = page.getByTestId("approve-in-paypal");
  const authorized = status(page).filter({ hasText: /Authorized|Delivered|Verified|Completed|Revision|review/i });
  const which = await waiting(() =>
    Promise.race([
      gate.waitFor({ timeout: 240_000 }).then(() => "gate" as const),
      authorized.first().waitFor({ timeout: 240_000 }).then(() => "auto" as const),
    ]),
  );
  if (which === "auto") return;
  await gate.click();
  const approve = page.getByRole("button", { name: /Approve simulated hold/ });
  await approve.waitFor({ timeout: 30_000 });
  await hold(page, 1200);
  await approve.click();
  await waiting(() => page.waitForURL(/\/deals\//, { timeout: 60_000 }));
}

async function startScenario(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE}/workspace?scenario=${id}`);
  await page.getByTestId("intent-input").waitFor();
  await hold(page, 1500);
  await page.getByTestId("delegate").click();
  await waiting(() => page.waitForURL(/\/deals\/deal_/, { timeout: 60_000 }));
}

async function record(): Promise<string> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(path.join(WORK, "video"), { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    recordVideo: { dir: path.join(WORK, "video"), size: SIZE },
  });
  const page = await context.newPage();
  t0 = Date.now();

  // 0 — the problem
  startScene(0);
  await page.goto(BASE);
  await titleCard(page, "PACT", "Who decides when an AI agent deserves to get paid?");
  await hold(page, 4500);
  await clearTitle(page);
  await caption(page, CAPTIONS[0]);
  await hold(page, 4000);
  await show(page, page.locator("text=Settlement rail").first(), 120);
  await hold(page, 3500);

  // 1 — delegate
  startScene(1);
  await page.goto(`${BASE}/workspace?scenario=happy-path`);
  await caption(page, CAPTIONS[1]);
  await page.getByTestId("intent-input").waitFor();
  await hold(page, 5500);
  await page.getByTestId("delegate").click();
  await waiting(() => page.waitForURL(/\/deals\/deal_/, { timeout: 60_000 }));
  await caption(page, CAPTIONS[1]);
  await hold(page, 2500);

  // 2 — negotiation
  startScene(2);
  await caption(page, CAPTIONS[2]);
  await show(page, page.getByTestId("section-negotiation"));
  await waiting(() => page.getByTestId("negotiation-result").waitFor({ timeout: 180_000 }));
  await show(page, page.getByTestId("negotiation-move").nth(1));
  await hold(page, 3000);
  await show(page, page.getByTestId("negotiation-result"), 520);
  await hold(page, 3500);

  // 3 — contract and authorization
  startScene(3);
  await caption(page, CAPTIONS[3]);
  await show(page, page.getByTestId("section-contract"));
  await hold(page, 4500);
  await show(page, page.getByTestId("contract-hash"), 400);
  await hold(page, 2500);
  await passPaymentGate(page);
  await caption(page, CAPTIONS[3]);
  await show(page, page.getByTestId("section-payment"));
  await hold(page, 4500);

  // 4 — delivery, verification, capture
  startScene(4);
  await caption(page, CAPTIONS[4]);
  await waiting(() => page.getByTestId("delivery-tile").first().waitFor({ timeout: 180_000 }));
  await show(page, page.getByTestId("section-delivery"));
  await hold(page, 3500);
  await waitForStatus(page, /Completed/);
  await show(page, page.getByTestId("section-verification"));
  await hold(page, 5000);
  await show(page, page.getByTestId("section-outcome"));
  await hold(page, 3500);

  // 5 — failed verification and revision
  startScene(5);
  await startScenario(page, "revision");
  await caption(page, CAPTIONS[5]);
  await passPaymentGate(page);
  await caption(page, CAPTIONS[5]);
  await waiting(() => page.getByTestId("delivery-missing").first().waitFor({ timeout: 240_000 }));
  await show(page, page.getByTestId("section-delivery"));
  await hold(page, 3500);
  await show(page, page.getByTestId("verification-banner").first(), 260);
  await hold(page, 4000);
  await waitForStatus(page, /Completed/);
  await show(page, page.getByTestId("section-outcome"));
  await hold(page, 3000);

  // 6 — policy approval, then hostile delivery
  startScene(6);
  await startScenario(page, "approval");
  await caption(page, CAPTIONS[6]);
  await waiting(() => page.getByTestId("approve-spend").waitFor({ timeout: 240_000 }));
  await show(page, page.locator("#gate-approval"));
  await hold(page, 4000);
  await page.getByTestId("approve-spend").click();
  await hold(page, 1500);
  await startScenario(page, "injection");
  await caption(page, CAPTIONS[6]);
  await waiting(() => page.getByTestId("approve-spend").waitFor({ timeout: 240_000 }));
  await page.getByTestId("approve-spend").click();
  await passPaymentGate(page);
  await caption(page, CAPTIONS[6]);
  await waiting(() => page.locator("#gate-review").waitFor({ timeout: 240_000 }));
  await show(page, page.getByTestId("section-verification"));
  await hold(page, 3500);
  await show(page, page.locator("#gate-review"));
  await hold(page, 1500);
  await page.getByTestId("reject-delivery").click();
  await page.getByRole("dialog").getByRole("button", { name: /Reject and void/ }).click();
  await waitForStatus(page, /Rejected|voided/i);
  await show(page, page.getByTestId("section-outcome"));
  await hold(page, 3000);

  // 7 — operations
  startScene(7);
  await page.goto(`${BASE}/operations`);
  await caption(page, CAPTIONS[7]);
  await waiting(() => page.getByTestId("studio-canvas").waitFor({ timeout: 90_000 }));
  await show(page, page.getByTestId("ops-kpis"), 120);
  await hold(page, 3500);
  await show(page, page.getByTestId("studio-dashboard"), 90);
  await hold(page, 3000);
  await page.getByTestId("studio-agents-toggle").click();
  const starter = page.getByText("Which deals need a human right now?").first();
  await starter.waitFor({ timeout: 30_000 });
  await hold(page, 1200);
  await starter.click();
  await waiting(() => page.getByText(/Delegated to PACT auditor/).first().waitFor({ timeout: 90_000 }).catch(() => undefined));
  await hold(page, 6000);

  // 8 — close
  startScene(8);
  await caption(page, "");
  await titleCard(page, "PACT", "Trust infrastructure for the agent economy.", "pact-agent-commerce.vercel.app · github.com/dorakingx/pact-agent-commerce");
  await hold(page, 5000);
  mark("show");
  if (open) open.to = now();

  await context.close();
  await browser.close();
  const files = readdirSync(path.join(WORK, "video")).filter((f) => f.endsWith(".webm"));
  const raw = path.join(WORK, "raw.webm");
  renameSync(path.join(WORK, "video", files[0]), raw);
  writeFileSync(path.join(WORK, "timeline.json"), JSON.stringify(segments.filter((s) => s.to > s.from), null, 1));
  return raw;
}

/* ------------------------------------------------------------------ composition */

function duration(file: string): number {
  return Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim(),
  );
}

function narrate(): number[] {
  return NARRATION.map((text, i) => {
    const aiff = path.join(WORK, `n${i}.aiff`);
    execFileSync("say", ["-v", VOICE, "-r", "182", "-o", aiff, text]);
    return duration(aiff);
  });
}

function compose(raw: string, voice: number[]): string {
  const timeline = segments.filter((s) => s.to - s.from > 0.05);
  const parts: string[] = [];
  const labels: string[] = [];
  const sceneStart: number[] = [];
  let cursor = 0;
  for (let s = 0; s < NARRATION.length; s += 1) {
    const segs = timeline.filter((x) => x.scene === s);
    const showTime = segs.filter((x) => x.kind === "show").reduce((a, x) => a + x.to - x.from, 0);
    const waitTime = segs.filter((x) => x.kind === "wait").reduce((a, x) => a + x.to - x.from, 0);
    // Real-time footage plays at 1x. Waits (model latency, PayPal round trips) are compressed to a few
    // seconds, but never so much that the scene ends before its narration does.
    const minimum = voice[s] + 1.2;
    const waitBudget = waitTime > 0 ? Math.max(Math.min(waitTime, 2 + 0.12 * waitTime), minimum - showTime) : 0;
    const waitFactor = waitTime > 0 ? Math.max(1, waitTime / waitBudget) : 1;
    const showFactor = 1;
    const padding = Math.max(0, minimum - showTime - waitTime / waitFactor);
    sceneStart[s] = cursor;
    for (const seg of segs) {
      const factor = Math.min(seg.kind === "wait" ? waitFactor : showFactor, 40);
      const label = `v${labels.length}`;
      parts.push(`[0:v]trim=start=${seg.from.toFixed(3)}:end=${seg.to.toFixed(3)},setpts=(PTS-STARTPTS)/${factor.toFixed(4)}[${label}]`);
      labels.push(`[${label}]`);
      cursor += (seg.to - seg.from) / factor;
    }
    if (padding > 0 && labels.length > 0) {
      const last = parts.length - 1;
      parts[last] = parts[last].replace(/\[(v\d+)\]$/, `,tpad=stop_mode=clone:stop_duration=${padding.toFixed(3)}[$1]`);
      cursor += padding;
    }
  }
  const audioInputs = NARRATION.map((_, i) => ["-i", path.join(WORK, `n${i}.aiff`)]).flat();
  const delays = NARRATION.map((_, i) => `[${i + 1}:a]adelay=${Math.round((sceneStart[i] + 0.35) * 1000)}:all=1[a${i}]`);
  const filter = [
    ...parts,
    `${labels.join("")}concat=n=${labels.length}:v=1:a=0,fps=30,format=yuv420p[v]`,
    ...delays,
    `${NARRATION.map((_, i) => `[a${i}]`).join("")}amix=inputs=${NARRATION.length}:normalize=0,apad[a]`,
  ].join(";");
  mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, "pact-demo.mp4");
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", raw, ...audioInputs, "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out],
    { stdio: "inherit" },
  );
  return out;
}

// --compose-only reuses the last recording (artifacts/tmp/demo) to iterate on the edit without re-running deals.
let raw: string;
if (args.has("compose-only")) {
  raw = path.join(WORK, "raw.webm");
  segments.push(...(JSON.parse(readFileSync(path.join(WORK, "timeline.json"), "utf8")) as Segment[]));
} else {
  raw = await record();
}
const voice = narrate();
const out = compose(raw, voice);
console.log(`Wrote ${out} (${duration(out).toFixed(1)} s)`);
