# PACT — Programmable Agent Commerce Trust

Trust and settlement infrastructure for agent-to-agent commerce, built on PayPal.

A human gives a buyer AI agent a task. The buyer agent negotiates machine-readable terms with a
seller AI agent. PACT compiles a hashed contract, checks a deterministic spending policy, and
places a PayPal **authorization** (funds held, not captured). The seller agent delivers, a verifier
checks the delivery against the contract, and PACT **captures only if the contract is satisfied** —
otherwise it asks for a revision, asks a human, or voids the authorization.

> Language models propose. Deterministic code decides. PayPal moves the money.

- [Architecture](docs/architecture.md) — lifecycle, state machines, how a step executes
- [Security model](docs/security.md) — trust boundaries, threats and controls
- [PayPal Sandbox setup](docs/paypal-sandbox-setup.md)
- [Plan and progress](docs/PLAN.md)

## Run it

Requires Node 24 (`.nvmrc`). Nothing else is needed to run locally: without PayPal credentials
PACT uses a clearly labelled payment simulator, without a database URL it uses in-process Postgres
(PGlite), and with `PACT_AI_MODE=scripted` the agents are deterministic and call no model.

```bash
npm ci
cp .env.example .env.local   # optional; every variable is documented there
npm run dev                  # http://localhost:3000
```

## Verify it

```bash
npm run typecheck        # next typegen + tsc (strict)
npm run lint
npm test                 # unit + integration (PGlite, simulator, scripted agents; no network)
npm run build
npm run test:e2e         # Playwright against the production build (needs `npx playwright install chromium` once)
npm run validate         # all of the above, in that order
```

The live PayPal Sandbox tests (`tests/sandbox`, also `npm run test:sandbox`) are part of `npm test`
and skip themselves unless `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set.

`tests/integration/core-flow.test.ts` plays the four demo scenarios end to end on the real
modules — negotiation, contract, policy, authorization, delivery, verification, capture or void —
and asserts that capture is refused at every stage before a delivery is verified.

## Layout

| Path | What lives there |
|---|---|
| `src/lib/domain` | The deterministic core: schemas, state machines, negotiation rules, contract compiler, policy, verification, settlement guards, audit chain |
| `src/lib/payments` | PayPal Sandbox REST client, the labelled simulator, the idempotent payment orchestrator, webhook handling |
| `src/lib/ai` | Buyer, seller and verifier agents (Vercel AI SDK through the AI Gateway) and their scripted fallbacks |
| `src/lib/studio` | The seller studio: produces the deliverables (sanitized SVG illustrations, multilingual copy) |
| `src/lib/db` | Drizzle schema, repositories, idempotency ledger (Postgres in production, PGlite locally and in CI) |
| `src/components`, `src/app` | Design system, application shell and pages |
| `drizzle` | SQL migrations |
| `tests/integration`, `tests/sandbox` | Cross-module tests, and live PayPal Sandbox tests |

PACT runs against the PayPal **Sandbox** only and refuses to talk to the live API.

## License

[MIT](LICENSE)
