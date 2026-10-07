# PACT — execution plan and progress

Working plan for building PACT into a judge-ready PayPal AI Hackathon submission.
Deadline: **12 Nov 2026, 12:00 PT**. Judging: 1–15 Dec 2026.

## Positioning

Agents that negotiate are easy to demo. PACT is the **trust infrastructure** underneath: the part
that decides, deterministically and auditably, whether negotiated work has earned its payment.

1. **Contract-bound payments** — the negotiated contract is a hashed, immutable artifact and the
   PayPal order carries that hash. Capture is refused if the contract, report and order disagree.
2. **A closed settlement state machine** shown live — revision loop, void, partial capture,
   human review, policy block, authorization expiry — not just the happy path.
3. **Stochastic agents strictly outside the money path** — LLMs only propose; deterministic
   engines decide; a tamper-evident audit chain records why.
4. **Delegated agent wallet** — one human consent (PayPal Vault) plus spending policy lets the
   agent authorize in-policy deals without a human, and never beyond policy.
5. **Operations surface** built on AG Studio (custom widgets + a custom auditor agent in the
   Studio Agent Framework) rather than a decorative table.

## Architecture decisions

| Area | Decision | Why |
|---|---|---|
| Runtime | Next.js 16 App Router, React 19, TypeScript, Node 24 | Vercel default; AI SDK 7 needs Node ≥ 22 |
| AI | Vercel AI SDK 7 via AI Gateway; buyer = Gemini 2.5 Flash, seller = GPT-5 mini, verifier = Gemini 2.5 Flash (vision) | Two independent model families negotiate; no provider keys in the repo; structured output via Zod |
| Payments | PayPal Sandbox REST: Orders v2 (intent AUTHORIZE), Payments v2 (capture / void / reauthorize), Vault v3, Webhooks v1 | Raw REST gives per-call `PayPal-Request-Id`, `debug_id` and negative-testing headers |
| PayPal + AI | PayPal Agent Toolkit, read-only tools only, for the auditor agent | The toolkit cannot authorize/void; LLMs get no money-moving tool by construction |
| Persistence | PostgreSQL + Drizzle; PGlite in-process for local dev and CI | Same schema and SQL migrations everywhere; zero services needed to run tests |
| Ops dashboard | AG Studio 3 (+ AG Grid 36, AG Charts 14) | Sponsor prize is judged on Studio, custom widgets, theming, agent framework |
| Tests | Vitest 4 (unit, integration, live-sandbox projects), Playwright 1.63 | Sandbox project auto-skips without credentials |

## Phases

- [x] 0. Environment, research, repo, Vercel project
- [x] 1. Foundation — schemas, state machines, provider contract, DB schema
- [x] 2. Core modules — domain engines, PayPal client, agents, seller studio, persistence, design system
- [x] 3. Service layer + API — step engine, sessions, policy, webhooks, ops queries
- [x] 4. Product UI — landing, workspace, deal view, operations (AG Studio), policies
- [x] 5. E2E tests, CI, production deploy, live PayPal Sandbox verification
- [x] 6. Adversarial review and fixes (security, financial correctness, UX)
- [x] 7. Docs, screenshots, demo video, Devpost package
- [ ] 8. Improvement loop until the definition of done holds (in progress)

## Needs the project owner

These cannot be done by an agent and are tracked in `docs/devpost-submission.md`:

- ~~PayPal Sandbox REST app credentials, with Vault enabled~~ done 7 Oct (US sandbox merchant; the JP default account had no Vault permission)
- ~~One-time sandbox buyer consent for the delegated demo wallet~~ done 7 Oct
- A sandbox buyer login to share with judges (optional)
- ~~Production database (managed Postgres)~~ done 7 Oct (Neon via Vercel)
- AG Studio 45-day trial licence key (request on or after 1 Nov so it covers judging)
- YouTube upload of the demo video; Devpost personal and eligibility fields; final submit

## Progress log

- 2026-10-06 — Environment inspected; Next.js 16 scaffold;
  GitHub repo and Vercel project created and linked; AI Gateway verified with Gemini 2.5 Flash and GPT-5 mini.
- 2026-10-06/07 — Core modules, service layer, HTTP API, product UI, AG Studio dashboard; adversarial
  review (31 confirmed findings, all fixed); E2E suite. Neon Postgres and PayPal Sandbox (US app, Vault,
  verified webhooks, shared demo wallet) live in production; all four scenarios verified against the
  real Sandbox; 8 showcase deals seeded; screenshots and demo video recorded from production.
- 2026-10-07 — Submitted to Devpost: https://devpost.com/software/pact-208alp (editable until 12 Nov 2026).
