# Changelog

All notable changes to PACT. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Deterministic domain core: seller-first negotiation rules with clamps and vetoes, contract
  compiler with SHA-256 terms hash, five-check spending policy, per-rule verification with a
  computed decision, capture guard, hash-chained audit trail.
- PayPal Sandbox integration over REST: Orders v2 with `intent=AUTHORIZE`, Payments v2 capture
  (full and final-partial), void and re-authorize, Vault v3 delegated wallet, verified webhooks,
  `PayPal-Request-Id` idempotency with a ledger table.
- Buyer, seller and verifier agents on the Vercel AI SDK through the AI Gateway (Gemini 2.5 Flash
  and GPT-5 mini), with scripted fallbacks and a degraded mode that can only route to human review.
- Seller studio that renders to-spec deliverables, a strict SVG sanitizer, and two labelled
  controlled-fault seller profiles for the failure scenarios.
- Auditor agent that reconciles PayPal's record with the ledger through the PayPal Agent Toolkit
  (`get_order`, read-only).
- Step engine and HTTP API: one lifecycle step per request under a per-deal lease, spend
  reservation under an owner lock, human gates, signed anonymous sessions, rate limits.
- PostgreSQL persistence with Drizzle migrations; PGlite for local development and CI.
- Brand, design system, landing page.
- Unit, integration, live-Sandbox and Playwright end-to-end test suites; GitHub Actions CI.
- Architecture, security model, PayPal Sandbox setup, judging matrix and demo script documents.
