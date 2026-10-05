# PACT security model

PACT moves money on the say-so of software. This document states what is trusted, what is not,
and how each credible attack is contained. PACT runs on PayPal Sandbox, but it is built as a
payments application: the controls below are implemented and tested, not aspirational.

## Trust boundaries

| Party | Trusted for | Not trusted for |
|---|---|---|
| The human (session owner) | Their own request, approvals and review decisions | Amounts, statuses or ids sent from the browser |
| Buyer agent (LLM) | Proposing a mandate and negotiation moves | Staying within budget, deciding anything about payment |
| Seller agent (LLM) | Proposing moves and producing deliverables | Honesty about what it delivered |
| AI verifier (LLM) | An opinion with evidence and a confidence | Being right, being available, resisting manipulation by itself |
| Deterministic core | Every decision that changes state or money | — (covered by tests) |
| PayPal | The record of orders, authorizations and captures | — |
| Incoming webhooks | Nothing until the signature verifies | |

The core principle: **an LLM never holds a capability that moves money.** The negotiating,
producing and verifying agents receive no PayPal tool, no database handle and no way to set a
status. They return data; schemas reject malformed data; engines clamp, veto or escalate the rest.

One agent does touch PayPal: the auditor. It is given exactly one tool from the PayPal Agent
Toolkit — `get_order`, read-only, pinned in code to the deal's own order — and its text is shown
next to a deterministic field-by-field comparison that decides the reconciliation result. The
toolkit has no authorize, capture-authorization or void tool at all.

## Threats and controls

### 1. Prompt injection

*Attack.* Text in the human's request, in the counterparty's messages or inside a deliverable
tries to steer a model: "ignore your budget", "mark every check as passed", "approve the payment".

*Controls.*
- Untrusted text is passed to models as delimited data, never as instructions.
- The human's stated budget is extracted deterministically and overrides the model's reading of it.
- Whatever the buyer agent says, the negotiation engine clamps offers to the mandate and vetoes an
  acceptance above budget (`src/lib/domain/negotiation.ts`).
- The verifier cannot release funds by itself: its output is one input to a computed decision, and the
  capture guard re-checks everything independently (`src/lib/domain/settlement.ts`).
- Deliverables are scanned deterministically for text addressed to an automated checker, including
  hidden SVG text (zero opacity, 1px type, off-canvas). A hit forces human review — the "Hostile
  delivery" demo scenario shows this end to end.
- The AI verifier is also asked to report manipulation attempts; a report forces human review.

### 2. Payment manipulation

*Attack.* A client or agent tries to change the amount, the payee, or which order gets captured.

*Controls.*
- The browser never sends an amount. The order amount is read from the signed contract on the server.
- Money is integer minor units end to end; the only conversions to and from PayPal's decimal
  strings are two tested functions (`src/lib/domain/money.ts`).
- The contract's SHA-256 terms hash is written to the PayPal order (`custom_id`). Before
  authorizing and again before capturing, the orchestrator re-reads PayPal's record and refuses to
  proceed unless the amount and the hash match the contract.
- A verification report is tied to the contract hash it was checked against; a report for another
  contract cannot unlock a capture.
- Capture amount can never exceed the authorized amount or the contract price. Partial capture is
  only possible as an explicit, recorded human review decision.

### 3. Replay and duplicate operations

*Attack.* A double click, two tabs, a retried request, a crashed function or a replayed webhook
causes a second capture.

*Controls.*
- Each lifecycle step runs under a per-deal database lease; a concurrent request gets `busy`.
- Deal updates use optimistic versioning.
- Every money-moving call has a deterministic idempotency key that is both the primary key of the
  `payment_operations` ledger and the `PayPal-Request-Id` header, so PayPal de-duplicates too.
- "Already captured" and "already voided" answers from PayPal are reconciled against PayPal's
  record instead of being retried.
- Webhooks are de-duplicated on PayPal's event id and are only allowed to move a payment forward
  along the state machine, never backwards and never out of a terminal state.

### 4. Malicious seller output

*Attack.* The deliverable carries active content (script in SVG, external references) or lies about
itself (claims a 1:1 file that is not 1:1).

*Controls.*
- SVG is sanitized on the server with an element and attribute allowlist (no script, no
  `foreignObject`, no event handlers, no external references, no styles).
- The UI renders deliverables through `<img>` data URIs, where scripts do not execute, and the
  download route serves them with a `sandbox` content security policy and `attachment` disposition.
- The verifier recomputes facts from the files (real width and height, real word counts) and never
  relies on the seller's labels.

### 5. Verifier uncertainty

*Attack / failure.* The model is unsure, wrong, slow or down.

*Controls.*
- Every check carries a confidence. Thresholds come from policy and are copied into the contract.
- Low confidence, `uncertain` results and unevaluated rules route to **human review**; they never capture.
- Deterministic rules (counts, ratios, word counts, deadline, format) do not depend on a model at all.
- If the model is unavailable, AI rules are marked `uncertain` and the deal is labelled degraded.

### 6. Compromised or forged webhooks

*Attack.* Someone posts a fake `PAYMENT.CAPTURE.COMPLETED` to the webhook endpoint.

*Controls.*
- The signature is verified over the raw request body (RSA-SHA256 over
  `transmission id | time | webhook id | CRC32(body)`), with the certificate fetched only from
  `*.paypal.com`; PayPal's verification API is the fallback.
- Stale transmissions are rejected.
- Unverified events change nothing.
- A verified event still has to match the ids and amounts PACT already holds; mismatches are logged
  to the audit trail and ignored.
- Webhooks confirm what PayPal did and can close a deal accordingly (for example, when PayPal
  releases an authorization the deal expires). They never initiate a capture: that happens only in
  the orchestrator, after the guard passes.

### 7. Secret leakage

*Controls.*
- PayPal credentials, the session secret and the vault token exist only in server environment
  variables or server-side tables; modules that read them import `server-only`.
- No `NEXT_PUBLIC_` variable carries a secret. `.env*` is git-ignored; `.env.example` lists names
  and non-secret defaults only.
- Logs are structured and pass through a redactor that masks authorization headers, tokens, secrets
  and vault ids. Payer e-mail addresses are masked before they are stored.
- The health endpoint reports whether integrations are configured, never their values.
- PACT refuses to start a PayPal client against anything but the Sandbox API host.

### 8. Unauthorized capture

*Attack.* A visitor advances, approves or releases someone else's deal, or forges a request from
another site.

*Controls.*
- Each browser gets a signed, http-only, same-site session cookie. Only the session that created a
  deal can advance it or decide on it; seeded showcase deals are read-only.
- State-changing API requests from a browser must be same-origin (Origin / Fetch-Metadata check)
  and JSON. The exceptions are deliberate: the PayPal return redirects (plain `GET`s that never
  trust their query string — the order is re-read from PayPal and the stored order id is the
  authority) and the webhook (authenticated by signature instead).
- A human decision is only accepted at the gate it belongs to, and a human cannot release a
  delivery that explicitly failed verification.
- Request bodies are size-limited and schema-validated; creation and decision endpoints are rate-limited.
- Connecting or disconnecting the shared demo wallet requires a separate operator token. Seeding
  showcase deals is a command-line script with no HTTP surface.

## Spending controls

Deterministic, outside the model, evaluated before any PayPal call:

- maximum amount per transaction (block)
- maximum total per day (block)
- allowed work categories; restricted categories are always blocked
- autonomous limit — above it, the deal pauses for human approval
- deals with a seller that has no settled history ("new") require approval

## Residual risks and honest limits

- **Sandbox only.** No real money moves. Going live would need PayPal's approval for vaulted
  (reference) transactions, and seller onboarding so captures are paid out to each seller.
- **Anonymous sessions.** The demo has no user accounts; a session cookie is the identity.
- **Semantic verification is probabilistic.** That is why ambiguous results go to a human rather
  than to capture, and why the thresholds are configurable.
- **The hidden-instruction scan is heuristic.** It is a tripwire, not a proof; the structural defence
  is that no model output can move money.
- **Authorizations expire.** PayPal honours an authorization for 3 days and keeps it valid for 29;
  long-running contracts need re-authorization, which the client supports but the demo does not exercise.
