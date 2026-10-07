# Demo video script

Target length **2:40–2:50** (hard limit 3:00). 1920×1080, recorded from the hosted demo on
PayPal Sandbox. No music. English narration; on-screen captions carry the same message for
viewers watching without sound.

The recording is automated (`scripts/demo/record.mts`, Playwright) so it can be re-shot after any
change; narration can be replaced with a human voice-over using the timings below.

## Storyboard

| Time | Scene | On screen | Narration |
|---|---|---|---|
| 0:00–0:14 | **The problem** | Title card, then the landing page hero and settlement rail | "AI agents can negotiate and do the work. But who decides when they deserve to get paid? Today it's a human — or the agent itself. PACT makes payment a consequence of verified delivery." |
| 0:14–0:30 | **A human delegates a task** | Workspace. Scenario "Verified delivery": *three landing-page illustrations, under $50, by tomorrow 6 PM, 16:9 and 1:1, one revision.* Click **Delegate to buyer agent** | "I give my buyer agent a task and a budget, in plain language. That budget becomes a hard ceiling the agent cannot cross." |
| 0:30–0:52 | **Agents negotiate** | Deal view: the seller's opening quote, counter-offers with price deltas, model badges (GPT-5 mini vs Gemini 2.5 Flash), agreement line | "The buyer agent negotiates with a seller agent running on a different model. They trade price against deadline and revisions. A rules engine clamps every offer — the models can propose, but they can't break their limits." |
| 0:52–1:14 | **Contract and authorization** | Contract card (price, deliverables, six verification rules, terms hash) → payment rail moves to **Authorized**; held amount, PayPal order and authorization ids | "The agreed terms compile into a machine-readable contract with its own verification rules, and a hash. PACT creates a PayPal order carrying that hash and authorizes it. The money is held — not captured." |
| 1:14–1:38 | **Delivery, verification, capture** | Delivery gallery (six files) → verification table: condition, PASS, evidence, confidence, evaluator → rail moves to **Captured**; capture id; audit trail | "The seller delivers. Every contract condition is checked: counts and real aspect ratios by code, the brief by an AI verifier that looks at the images. Each one has evidence and a confidence. All six pass — and only now does PACT capture the payment." |
| 1:38–2:04 | **Failed verification** | Scenario "Failed verification": delivery grid with a dashed "1:1 — not delivered" tile; report row FAIL "1:1 missing on illustration #2"; banner "Not captured"; revised delivery; re-verification passes; captured | "Now a seller that cuts corners. One required file is missing. The verifier names exactly what failed, and nothing is captured. The seller revises, PACT verifies again, and only then releases the payment." |
| 2:04–2:24 | **Policy and human approval** | Scenario "Human approval": gate "Human approval required — $180.00 exceeds the $100.00 autonomous limit" → **Approve spend**. Cut to "Hostile delivery": hidden instructions flagged → **Reject and void** → "Authorization voided" | "Autonomy has a ceiling. Above the limit I set, the agent stops and asks. And when a seller hides instructions for the verifier inside its file, PACT flags it, a human rejects it, and the authorization is voided." |
| 2:24–2:44 | **Operations** | Operations dashboard: settlement rail widget, held vs captured, review queue; ask the auditor agent "Which deals need a human right now?"; ledger grid filter + drilldown | "Operations shows every contract: what's held, what's captured, what failed and why. It's built on AG Studio, with an auditor agent that can explain any deal and reconcile it with PayPal — but can't move a cent." |
| 2:44–2:52 | **Close** | Title card: PACT — Trust infrastructure for the agent economy. URL and GitHub | "PACT. Trust infrastructure for the agent economy." |

## Recording notes

- Record against the production deployment with real PayPal Sandbox payments; the header must
  read "PayPal Sandbox · live". The delegated demo wallet is used so no login screen interrupts
  the flow.
- Use the light theme at 1920×1080, browser chrome hidden.
- Auto-run stays on; the script waits on visible state (status text), never on fixed delays.
  Long model waits are trimmed in the edit, never faked.
- Keep the cursor still while reading; move it deliberately to the element being described.
- Captions: lower third, two lines maximum, same wording as the narration (shortened).
- Do not show e-mail addresses, tokens or the admin token. PayPal sandbox ids are fine.

## Shot list for stills (`artifacts/devpost/`)

| File | Captured at |
|---|---|
| `01-landing.png` | Landing page, top of page |
| `02-negotiation.png` | Deal view after agreement, negotiation section |
| `03-contract.png` | Contract card with rules and terms hash |
| `04-authorized.png` | Payment section at "Authorized", held amount and PayPal ids |
| `05-verification.png` | Verification report, all conditions passed |
| `06-captured.png` | Outcome banner and payment rail at "Captured" |
| `07-failed-verification.png` | "Failed verification" scenario: missing tile and failing row |
| `08-operations.png` | Operations dashboard (AG Studio) |
