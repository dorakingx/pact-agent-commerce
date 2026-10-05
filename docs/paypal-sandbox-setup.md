# PayPal Sandbox setup

PACT talks to the real PayPal Sandbox. This takes about five minutes and costs nothing.
Without these credentials PACT still runs, using a payment simulator that labels every
payment as simulated.

## 1. Create a sandbox REST app

1. Sign in at <https://developer.paypal.com/dashboard/> (a free PayPal developer account).
2. Make sure the **Sandbox** toggle is on (top right), then open **Apps & Credentials**.
3. Use the **Default Application** or create an app (type: *Merchant*). Name it anything, e.g. `PACT`.
4. Copy the **Client ID** and **Secret**.

## 2. Enable Vault (for the delegated agent wallet)

In the app's page: **Features → Accept payments → Advanced options → Vault** → tick it and save.

This lets a human consent once so the buyer agent can authorize in-policy deals without a PayPal
login. If you skip it, PACT falls back to interactive approval for every deal.

## 3. Configure PACT

Local development — put the credentials in `.env.local` (git-ignored):

```bash
PAYPAL_CLIENT_ID=your-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-sandbox-secret
```

Vercel — add the same two variables to the project (Production and Preview):

```bash
vercel env add PAYPAL_CLIENT_ID production
vercel env add PAYPAL_CLIENT_SECRET production --sensitive
```

## 4. Register the webhook

PACT verifies PayPal's webhook signatures, which needs the webhook's id:

```bash
npx tsx scripts/paypal-webhook-register.ts https://<your-deployment>/api/webhooks/paypal
```

The script prints a webhook id. Store it as `PAYPAL_WEBHOOK_ID` (locally and on Vercel).
PayPal only delivers webhooks to public HTTPS URLs, so this step applies to a deployment,
not to `localhost`.

## 5. Sandbox accounts

A developer account comes with two sandbox accounts
(**Testing Tools → Sandbox Accounts**):

- a **Business** account — the merchant that owns your REST app and receives captures
- a **Personal** account — the buyer; it has test funds

Open the personal account (**⋯ → View/Edit account**) to see its e-mail and generated password.
You use it in two places:

- **Interactive approval** — when a deal reaches "Awaiting PayPal approval", click *Approve in PayPal*
  and sign in with the sandbox personal account.
- **Delegated wallet** — on PACT's **Policies** page click *Connect PayPal wallet* and approve once with the
  same account. From then on in-policy deals authorize with no login.

## What PACT calls

| Purpose | Endpoint |
|---|---|
| OAuth token | `POST /v1/oauth2/token` |
| Create order (intent `AUTHORIZE`) | `POST /v2/checkout/orders` |
| Read order | `GET /v2/checkout/orders/{id}` |
| Authorize approved order | `POST /v2/checkout/orders/{id}/authorize` |
| Read authorization | `GET /v2/payments/authorizations/{id}` |
| Capture (full or final partial) | `POST /v2/payments/authorizations/{id}/capture` |
| Void | `POST /v2/payments/authorizations/{id}/void` |
| Re-authorize | `POST /v2/payments/authorizations/{id}/reauthorize` |
| Vault setup token / payment token | `POST /v3/vault/setup-tokens`, `POST /v3/vault/payment-tokens` |
| Webhook registration and verification | `POST /v1/notifications/webhooks`, `POST /v1/notifications/verify-webhook-signature` |

Every mutating call carries a deterministic `PayPal-Request-Id`, so retries can never double-charge.

## Verify the integration

```bash
npm run test:sandbox
```

This runs the live Sandbox test suite (it is skipped automatically when no credentials are set).
