# Judging matrix

How PACT answers each PayPal AI Hackathon criterion, with the evidence a judge can check in
the product, the repository or the video. Criteria are quoted from the official rules; all five
are weighted equally.

## 1. Technological implementation

> How thoroughly and skillfully does the project use PayPal Developer Platform and AI tool(s)?
> Does the project reflect genuine effort and a working, non-trivial implementation?

| Evidence | Where to see it |
|---|---|
| Real PayPal Sandbox authorize → capture lifecycle: Orders v2 with `intent=AUTHORIZE`, order authorization, Payments v2 capture (full and final-partial), void, re-authorize | `src/lib/payments/paypal-client.ts`, `src/lib/payments/orchestrator.ts`; PayPal ids on every deal page |
| The contract is bound to the payment: the SHA-256 terms hash is the order's `custom_id`, and PayPal's own record is re-read and compared before authorizing and before capturing | `src/lib/domain/contract.ts`, `orchestrator.ts`; "Contract" and "Payment" sections of a deal |
| Idempotent money movement: deterministic `PayPal-Request-Id` per operation, an idempotency ledger table, crash-recovery that adopts an existing capture instead of repeating it | `src/lib/payments/idempotency.ts`, `payment_operations` table, `tests/integration/service-concurrency.test.ts` |
| Delegated agent wallet with PayPal Vault v3 (setup token → payment token → single-step authorization) | `src/lib/services/wallet.ts`; Policies page |
| Verified webhooks: RSA-SHA256 signature over the raw body with certificate pinning to `*.paypal.com`, replay window, de-duplication on event id | `paypal-client.ts` (`verifyWebhook`), `tests/integration/paypal-webhook.test.ts` |
| PayPal Agent Toolkit used by an auditor agent with one read-only tool (`get_order`) to reconcile PayPal's record against the ledger | `src/lib/ai/auditor.ts`; "Reconcile with PayPal" on a deal |
| Two independent model families negotiate (buyer: Gemini 2.5 Flash, seller: GPT-5 mini) through the Vercel AI SDK with schema-constrained output | `src/lib/ai/negotiators.ts`, `src/lib/ai/gateway.ts` |
| A vision verifier inspects rasterised deliverables against the contract and returns per-condition result, evidence and confidence | `src/lib/ai/verifier.ts`; "Verification" section of a deal |
| Deterministic core around the models: negotiation clamps and vetoes, contract compiler, policy engine, verification decision, capture guard — all pure functions | `src/lib/domain/` |
| Closed deal and payment state machines; one step per request under a per-deal lease; optimistic versioning | `src/lib/domain/status.ts`, `src/lib/services/deals.ts` |
| Test depth: unit, integration (in-process Postgres, scripted agents, simulator), live-Sandbox suite, and Playwright end-to-end journeys in CI | `npm run validate`; `.github/workflows/ci.yml` |

## 2. Design

> Does the project deliver a complete, coherent product experience — not just a technical proof of concept?

| Evidence | Where to see it |
|---|---|
| A landing page that explains the product in one screen | `/` |
| A guided workspace with four one-click scenarios and free-form requests | `/workspace` |
| A live deal view: lifecycle rail, two-sided negotiation transcript, designed contract document, policy checks, payment rail with held vs captured amounts, delivery gallery, evidence table, human gates, outcome | `/deals/{id}` |
| A plain-language, hash-chained audit trail beside every deal | right rail of a deal |
| Human control surfaces: approve or decline a spend, release, partially release, send back or reject a delivery | gates on a deal |
| Operations dashboard: AG Studio with custom widgets, theming and an auditor agent; an AG Grid ledger with filters, grouping, totals, drilldown and export; AG Charts | `/operations` |
| Editable spending policy with a live "what would happen" preview, and the delegated wallet | `/policies` |
| Consistent design system, light and dark themes, responsive down to phones, keyboard accessible | `src/components/ui/` |
| Honest states: simulated payments, scripted or degraded agents and demo-fault sellers are always labelled | throughout |

## 3. Potential impact

> Does the project make a credible, specific case for solving a real problem for a real audience —
> and does the solution actually address that problem based on what's demonstrated?

**The problem.** Agents can already negotiate and do work. Payment rails still assume a human decides
when work is finished. Today the choices are to pay up front and hope, or to let the agent that
did the work declare its own success. Neither is something a business can hand a budget to.

**Who it is for.** Teams that want to give agents purchasing authority (procurement of creative,
content, data and development work), marketplaces where sellers are agents, and platforms that
need to show a finance or risk owner exactly why each payment was released.

**What PACT changes.** Payment becomes a consequence of verified delivery:

| Claim | Demonstrated by |
|---|---|
| The buyer is never charged for work that fails its contract | "Failed verification" scenario: nothing captured until the revision passes; "Hostile delivery": authorization voided |
| The agent can spend autonomously, but only inside limits a human set | "Human approval" scenario; policy engine; delegated wallet |
| The seller is paid immediately once the contract is met, without waiting for a human | "Verified delivery" scenario: capture seconds after verification |
| Every release of money can be explained afterwards | audit trail, verification evidence, reconciliation with PayPal |

It runs on infrastructure businesses already have (a PayPal account), with no new custody model:
PACT holds nothing itself.

## 4. Innovation / idea

> How creative and novel is the concept and does the project differ from existing concepts?

- **Contract-aware settlement, not AI shopping.** The unit of work is a machine-readable contract
  with its own verification rules, and the payment is cryptographically tied to it.
- **A trust boundary as the product.** "LLMs propose, deterministic code decides" is enforced
  structurally: no model holds a capability that moves money, and a model outage can only ever
  route to a human, never to a capture.
- **Verification as evidence.** Each condition has a result, the observation behind it, a confidence
  and an evaluator — and ambiguity is a first-class outcome with its own path.
- **Adversarial sellers are in scope.** Deliverables are treated as hostile input: sanitised,
  measured rather than believed, and scanned for instructions aimed at the verifier.
- **Delegation with a ceiling.** One PayPal consent plus a deterministic policy gives an agent a
  wallet whose limits it cannot argue its way past.

## 5. Presentation

> Does the video clearly demonstrate the project working end-to-end? Does the pitch communicate what
> problem is solved, who it's for, and why it matters? Is the overall presentation easy to follow?

The three-minute video follows `docs/demo-script.md`. Each scene exists for a reason:

| Scene | Why it is there |
|---|---|
| The problem in one sentence | So the viewer knows what to watch for: who decides an agent deserves to be paid |
| A human delegates a task | Shows the starting point is plain language and a budget, nothing technical |
| Buyer and seller agents negotiate | Proves the agents are independent and that guardrails bound them |
| Contract and PayPal authorization | The pivot of the product: terms become a hashed contract and money is held, not moved |
| Delivery, verification, capture | The happy path end to end with real PayPal ids |
| Failed verification, revision | The reason PACT exists: a missing deliverable means no capture |
| Policy and human approval | Shows autonomy has a ceiling set by a person |
| Operations dashboard | Shows this is operable at scale and where AG Studio fits |
| Closing line | One sentence to remember |

Supporting material: the README (problem, architecture, setup, tests), `docs/architecture.md`,
`docs/security.md`, screenshots in `artifacts/devpost/`, and a hosted demo a judge can run in under
three minutes.
