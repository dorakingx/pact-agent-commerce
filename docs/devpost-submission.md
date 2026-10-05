# Devpost submission — PACT

Copy-paste source for every field of the PayPal AI Hackathon submission form
(<https://paypalaihackathon.devpost.com/>). Deadline: **12 November 2026, 12:00 PT**.

Fields marked **USER CONFIRMATION REQUIRED** are personal, legal or account-bound and must be
filled in by the project owner. Nothing in this file has been submitted.

---

## Project name

```
PACT
```

## Elevator pitch / tagline (max 140 characters)

```
Trust infrastructure for agent commerce: AI agents negotiate, and PayPal captures only when the work is verified against the contract.
```

Alternatives:

- `AI agents can negotiate. PACT makes sure they only get paid when the deal is done.`
- `Contract-aware PayPal settlement for AI agents: authorize first, verify the work, capture only if the deal was kept.`

## Thumbnail / image gallery

Upload from `artifacts/devpost/` in this order (3:2, PNG):

1. `01-landing.png` — the product in one screen
2. `02-negotiation.png` — buyer and seller agents negotiating
3. `03-contract.png` — the machine-readable contract
4. `04-authorized.png` — PayPal authorization held
5. `05-verification.png` — verification report with evidence
6. `06-captured.png` — payment captured
7. `07-failed-verification.png` — missing deliverable, nothing captured
8. `08-operations.png` — operations dashboard (AG Studio)

## Video demo link

**USER CONFIRMATION REQUIRED** — upload `artifacts/devpost/pact-demo.mp4` to YouTube as *Public*
and paste the link. Script: `docs/demo-script.md`. Length under three minutes, no music.

## "Try it out" links

```
https://pact-agent-commerce.vercel.app
https://github.com/dorakingx/pact-agent-commerce
```

## Built with (tags)

```
paypal, paypal-sandbox, paypal-orders-api, paypal-payments-api, paypal-vault, paypal-webhooks, paypal-agent-toolkit, vercel-ai-sdk, vercel-ai-gateway, gemini, gpt-5, ag-studio, ag-grid, ag-charts, next.js, react, typescript, tailwindcss, zod, postgresql, neon, drizzle-orm, vitest, playwright, vercel
```

---

## About the project (Markdown story)

### Inspiration

AI agents can already negotiate a price and produce the work. What they cannot do is be trusted
with the moment that matters: deciding that the work is done and money should move.

Payment rails assume a human makes that call. So agent commerce today has two bad options: pay
up front and hope, or let the agent that did the work announce its own success. No finance
team will hand a budget to either.

We wanted the missing layer between "the agents agreed" and "the money moved": something that
holds the funds, checks the delivery against what was actually agreed, and releases payment only
when the deal was kept — with a record a human can audit afterwards.

### What it does

PACT (Programmable Agent Commerce Trust) is a trust and settlement layer for agent-to-agent
commerce, built on PayPal.

1. **Intent.** A human describes a task in plain language: *"Get three landing-page illustrations
   for under $50 by tomorrow at 6 PM. I need both 16:9 and 1:1 versions and one revision."*
2. **Negotiation.** A buyer agent turns that into a mandate with a hard budget ceiling and
   negotiates with a seller agent, which quotes from its own private rate card. The two agents
   run on different model families. A rules engine clamps every offer: the buyer can never agree
   above budget, the seller never below its floor.
3. **Contract.** The agreed terms are compiled into a strict machine-readable contract with its own
   verification rules, and hashed.
4. **Policy.** A deterministic spending policy decides whether the agent may commit the money by
   itself, needs a human's approval, or is blocked.
5. **Authorization.** PACT creates a PayPal order with `intent=AUTHORIZE`, carrying the contract
   hash. The funds are held on the buyer's PayPal account — not captured. With a connected agent
   wallet (PayPal Vault) this needs no login; otherwise the buyer approves in PayPal.
6. **Delivery.** The seller agent delivers the work.
7. **Verification.** Deterministic checks (counts, real aspect ratios, word counts, deadline, file
   safety, hidden-instruction scan) and an AI verifier that looks at the deliverables produce a
   report: for every contract condition a result, the evidence, and a confidence.
8. **Settlement.** Only if every condition is verified does PACT capture the authorization. An
   explicit failure sends the work back for revision; an ambiguous result or a suspected
   manipulation attempt stops for human review; when revisions run out, the authorization is
   voided and nothing is ever captured.

Every step lands in a plain-language, hash-chained audit trail. An operations dashboard shows all
contracts, held and captured amounts, verification outcomes, risk and policy flags, and an
auditor agent can re-read PayPal's own record and reconcile it with the ledger.

Four one-click scenarios show every branch: a verified delivery that is captured, a delivery with a
missing file that is captured only after revision, a purchase above the agent's limit that waits
for a human, and a hostile delivery that hides instructions for the verifier and ends voided.

### How we built it

**Frontend.** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 and a small design
system on Radix primitives. The live deal view drives the lifecycle one step per request and
shows the negotiation, the contract, the payment rail, the deliverables, the evidence table and
the audit trail as they happen.

**Agents.** Vercel AI SDK 7 through the Vercel AI Gateway. The buyer agent and the verifier run on
Google Gemini 2.5 Flash; the seller agent runs on OpenAI GPT-5 mini — deliberately different
model families, because in real agent commerce the two sides are independent systems. Every model
call is a schema-constrained structured generation validated with Zod. The verifier is multimodal:
deliverables are rasterised and inspected as images.

**Deterministic core.** Negotiation rules, the contract compiler, the policy engine, the
verification decision and the capture guard are pure TypeScript functions. Models only propose;
these functions decide. The deal and payment lifecycles are closed, table-driven state machines.

**PayPal.** The PayPal Sandbox REST APIs, called directly so each request controls its
idempotency key:

- Orders v2 — create order with `intent=AUTHORIZE`, read order, authorize order
- Payments v2 — read, capture (full and final-partial), void and re-authorize authorizations
- Vault v3 — setup tokens and payment tokens for the delegated agent wallet
- Webhooks v1 — registration and signature verification (RSA-SHA256 over the raw body)
- PayPal Agent Toolkit — one read-only tool (`get_order`) for the auditor agent

**Operations.** AG Studio 3 for the dashboard (custom widgets, a theme bound to our design tokens,
and the Studio Agent Framework with a custom auditor agent), AG Grid 36 for the ledger and AG
Charts 14 for the charts.

**Persistence.** PostgreSQL (Neon) through Drizzle ORM, with version-controlled SQL migrations.
The same schema runs on PGlite, an in-process Postgres, for local development and CI.

**Quality.** More than 2,000 unit and integration tests (Vitest), a live PayPal Sandbox suite, and
Playwright end-to-end journeys for every scenario, all run in GitHub Actions. Deployed on Vercel.

### Challenges we ran into

- **Keeping stochastic agents away from the money.** It is easy to give an agent a "pay" tool.
  We did the opposite: no model holds any capability that moves money. That meant designing every
  agent output as a proposal and writing a deterministic engine that can clamp it, veto it or
  escalate it.
- **Making "done" checkable.** A contract is only useful if its conditions can be evaluated. We
  derive verification rules from the negotiated terms and split them into what code can measure
  (does a 1:1 file really have a 1:1 pixel ratio?) and what needs judgement (does the illustration
  match the brief?), and gave uncertainty its own path instead of forcing a yes or no.
- **Idempotent settlement.** A double click, a second tab, a crashed function or a replayed
  webhook must never capture twice. Each step runs under a per-deal lease, every PayPal call has a
  deterministic `PayPal-Request-Id` recorded in a ledger, and "already captured" is reconciled
  against PayPal's record rather than retried.
- **Binding the payment to the agreement.** We write the contract's hash into the PayPal order and
  re-read PayPal's own record before authorizing and capturing, so a payment can only settle
  against the contract it was created for.
- **Hostile deliverables.** A seller can try to talk the verifier into passing. Deliverables are
  sanitised, measured rather than believed, and scanned for hidden instructions; a hit goes to a
  human.
- **A demo that cannot fall over.** Models time out. Each call has a hard timeout, a fallback model
  and a scripted fallback, and a verifier outage can only ever lead to human review.

### Accomplishments that we're proud of

- A complete authorize → verify → capture lifecycle on the real PayPal Sandbox, including
  revision, partial release, void and human review — not only the happy path.
- A capture guard that refuses to release funds unless the contract hash, the verification
  report, the amounts, the authorization and PayPal's own record all agree.
- More than 2,000 automated tests, including concurrency tests that fire 50 simultaneous capture
  requests and prove exactly one capture happens.
- Two different model families negotiating against each other inside hard limits neither can
  cross.
- An operations surface a finance or risk owner could actually use, with an agent that can
  explain any deal and reconcile it against PayPal while being unable to change anything.

### What we learned

- The useful question is not "can the model do this?" but "what is the worst thing the model can
  cause?" Designing from that question made the system simpler: models propose, code decides.
- PayPal's authorize-and-capture flow is a natural fit for outcome-based payment. Authorization is
  the commitment; capture is the consequence.
- Confidence only matters if it changes behaviour. Routing low confidence to a human — rather than
  showing a number next to an automatic decision — is what makes AI verification acceptable for
  money.
- Idempotency keys are a design tool, not a detail: deriving them from the deal and the contract
  made every retry safe by construction.
- Treat everything a counterparty's agent sends as untrusted input, including its work.

### What's next for PACT

- **Richer contracts.** Milestones, staged captures, penalties and acceptance tests for code and
  data deliverables.
- **Seller discovery and reputation.** A directory where sellers are matched by capability, price
  and verified first-pass rate.
- **Multi-agent marketplaces.** Several sellers bidding for one contract, and contracts that split
  across them.
- **Cryptographic attestations.** Signed contracts and verification reports that either side can
  present to a third party.
- **Seller payouts.** Onboarding sellers as PayPal merchants so each capture is paid to the agent's
  principal.
- **Enterprise governance.** Roles, approval chains, budgets per team and export to finance systems.
- **An open protocol.** The HTTP API is already described in OpenAPI; the next step is letting
  third-party agents open and fulfil PACT contracts directly.

---

## Hackathon-specific questions

The exact custom questions are visible only inside the logged-in submission form. Answers are
prepared for the questions the rules and overview imply.

### How does the project use PayPal? (PayPal + AI requirement)

```
PACT's whole function is deciding when a PayPal payment may be captured.

PayPal (Sandbox, REST, called server-side):
- Orders v2: every deal creates an order with intent=AUTHORIZE for exactly the contract price. The contract's SHA-256 terms hash is written to custom_id and the contract id to invoice_id, so PayPal's record is bound to the agreement. PACT then authorizes the approved order.
- Payments v2: PACT captures the authorization only after the delivery is verified (full capture, or a final partial capture when a human reviewer releases part), voids it when the contract is not met, and supports re-authorization.
- Vault v3: a human can connect a PayPal account once (setup token → payment token). The buyer agent can then authorize in-policy deals with no PayPal login.
- Webhooks v1: PACT verifies PayPal's signature on the raw body and uses PAYMENT.AUTHORIZATION.* and PAYMENT.CAPTURE.* events to confirm state.
- PayPal-Request-Id on every money-moving call, backed by an idempotency ledger, so retries can never capture twice.
- PayPal Agent Toolkit: an auditor agent gets one read-only tool (get_order) and reconciles PayPal's record with PACT's ledger.

AI (Vercel AI SDK through the Vercel AI Gateway):
- Buyer agent (Google Gemini 2.5 Flash): reads the human's request, forms a mandate and negotiates.
- Seller agent (OpenAI GPT-5 mini): quotes, negotiates and produces the deliverables.
- Verifier (Gemini 2.5 Flash, multimodal): inspects the delivered work against the contract and returns per-condition results with evidence and confidence.
- Auditor agent: explains deals and reconciles them with PayPal, read-only.

Neither is superficial, and they are deliberately separated. The AI decides nothing about money: every model output is validated against a schema and passed through deterministic engines (negotiation limits, contract compiler, spending policy, verification decision, capture guard). Capture happens only when those engines agree that every contract condition passed with enough confidence. Low confidence, a model outage or a suspected manipulation attempt goes to a human; it can never trigger a capture.
```

### Which tools did you use and how? (Tools documentation)

```
PayPal Developer Platform — Sandbox REST APIs: Orders v2 (intent AUTHORIZE), Payments v2 (capture, void, re-authorize), Vault v3 (delegated agent wallet), Webhooks v1 (signature verification); PayPal Agent Toolkit (read-only get_order for the auditor agent).
AI — Vercel AI SDK 7 with the Vercel AI Gateway; Google Gemini 2.5 Flash (buyer agent, verifier, auditor); OpenAI GPT-5 mini (seller agent). Structured outputs validated with Zod.
AG Grid — AG Studio 3 (operations dashboard: custom widgets, custom theme, Studio Agent Framework with a custom auditor agent and custom tools); AG Grid 36 (ledger with filters, grouping, totals, drilldown, export); AG Charts 14.
App — Next.js 16, React 19, TypeScript, Tailwind CSS 4, Radix UI.
Data — PostgreSQL (Neon) with Drizzle ORM; PGlite for local development and CI.
Testing — Vitest, Playwright, GitHub Actions. Hosting — Vercel.
```

### Sponsor tools / prize categories

```
AG Grid: the operations dashboard is built on AG Studio 3 — a themed, multi-page dashboard with three custom widgets (settlement rail, human review queue, verdict card), layout editing, and the Studio Agent Framework running Studio's built-in agents plus a custom read-only "PACT auditor" agent with its own tools (list attention items, explain a deal, reconcile with PayPal). The ledger tab uses AG Grid for sorting, filtering, grouping, totals, drilldown and CSV export, and AG Charts for authorized vs captured, outcomes, verification results and volume.
```

Prize categories to opt into: **Grand prizes**, **Best Use of Agentic Commerce**, **Best Use of
PayPal + AI**, **Best Demo Delivery**, **Best Use of AG Grid** (a project can win one grand or
honourable-mention prize plus one sponsor prize).

### Testing instructions for judges

```
Hosted demo: https://pact-agent-commerce.vercel.app  (PayPal Sandbox — no real money moves)

Under three minutes:
1. Open the site and click "Run the live demo".
2. Pick the scenario "Verified delivery" and click "Delegate to buyer agent".
3. Watch the deal run: the two agents negotiate, a contract is created, PayPal authorizes the amount (held, not captured), the seller delivers, each contract condition is verified with evidence, and only then the payment is captured. The PayPal order, authorization and capture ids are shown on the page.
4. Try "Failed verification" (a required 1:1 file is missing: nothing is captured until the revision passes), "Human approval" (the price exceeds the agent's limit: click Approve spend) and "Hostile delivery" (hidden instructions are flagged: choose Reject and void).
5. Open "Operations" for the dashboard and the ledger; open "Policies" to change the agent's limits and see the outcome change.

No login is needed: the demo uses a pre-connected PayPal Sandbox wallet, so in-policy deals authorize automatically.
To approve a payment interactively in PayPal instead, sign in on the PayPal Sandbox page with:
  email: USER CONFIRMATION REQUIRED (sandbox personal account)
  password: USER CONFIRMATION REQUIRED
To run locally: see the README (npm ci && npm run dev works with no credentials, using a labelled payment simulator).
```

### Is this a new project or an existing one?

```
New. PACT was created for this hackathon; the repository's first commit is dated 6 October 2026, inside the submission period.
```

### Public code repository

```
https://github.com/dorakingx/pact-agent-commerce
```

License: MIT (`LICENSE` at the repository root).

### Hosted demo URL

```
https://pact-agent-commerce.vercel.app
```

---

## Fields only the project owner can answer

| Field | Value |
|---|---|
| Submitter name, team members | **USER CONFIRMATION REQUIRED** |
| Country / territory of residence | **USER CONFIRMATION REQUIRED** |
| Age of majority certification | **USER CONFIRMATION REQUIRED** |
| Not an employee / household member of PayPal, Devpost or a sponsor; not a judge | **USER CONFIRMATION REQUIRED** |
| Individual, team or organisation entry | **USER CONFIRMATION REQUIRED** |
| Acceptance of the official rules and Devpost terms | **USER CONFIRMATION REQUIRED** |
| YouTube video URL | **USER CONFIRMATION REQUIRED** (upload required) |
| PayPal Sandbox buyer credentials to share with judges | **USER CONFIRMATION REQUIRED** |
| Any tax or payment information requested for prizes | **USER CONFIRMATION REQUIRED** |

## Pre-submission checklist

- [ ] Production deployment shows "PayPal Sandbox · live" (credentials, webhook id and demo wallet configured)
- [ ] Production database is managed Postgres and showcase deals are seeded
- [ ] All four scenarios pass on the hosted demo
- [ ] `npm run validate` and CI are green on the submitted commit
- [ ] Screenshots in `artifacts/devpost/` were taken from the hosted demo
- [ ] Demo video is under three minutes, public on YouTube, without music
- [ ] AG Studio trial licence key is set and valid through 15 December 2026
- [ ] Repository is public and GitHub shows the MIT licence in "About"
- [ ] Every statement above still matches the product
- [ ] Project owner has reviewed this document and approved the submission
