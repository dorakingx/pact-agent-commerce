/**
 * Payment provider contract.
 *
 * Two implementations exist:
 *  - PayPalSandboxProvider — real PayPal Sandbox REST calls (Orders v2, Payments v2, Vault v3, Webhooks v1).
 *  - SimulatedProvider     — an in-process stand-in used ONLY when no PayPal credentials are configured
 *                            (local dev without keys, CI). Everything it produces is labelled "simulated".
 *
 * The LLM agents never receive a reference to a provider. Only the deterministic payment
 * orchestrator (./orchestrator.ts) calls these methods, and only after the settlement guards in
 * ../domain/settlement.ts and its own precondition checks pass.
 */

export type ProviderKind = "paypal_sandbox" | "simulated";

/** How the payer consented: interactively in PayPal, or via a pre-consented (vaulted) agent wallet. */
export type ApprovalMode = "interactive" | "delegated";

export type PayPalOrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED";

export type PayPalAuthorizationStatus =
  | "CREATED"
  | "CAPTURED"
  | "DENIED"
  | "PARTIALLY_CAPTURED"
  | "VOIDED"
  | "PENDING";

export type PayPalCaptureStatus =
  | "COMPLETED"
  | "DECLINED"
  | "PARTIALLY_REFUNDED"
  | "PENDING"
  | "REFUNDED"
  | "FAILED";

export interface AuthorizationInfo {
  authorizationId: string;
  status: PayPalAuthorizationStatus;
  amountMinor: number;
  currency: "USD";
  /** ISO timestamp after which the authorization can no longer be captured. */
  expiresAt: string | null;
  customId: string | null;
  invoiceId: string | null;
}

export interface OrderInfo {
  orderId: string;
  status: PayPalOrderStatus;
  amountMinor: number;
  currency: "USD";
  /** Echo of purchase_units[0].custom_id — PACT stores the contract terms hash prefix here. */
  customId: string | null;
  invoiceId: string | null;
  /** Where the payer approves, when payer action is required. */
  approveUrl: string | null;
  /** Present once the order has been authorized. */
  authorization: AuthorizationInfo | null;
  /** Masked payer e-mail if PayPal returned one (e.g. "sb****@personal.example.com"). */
  payerEmailMasked: string | null;
  /** Vault id returned when the payer agreed to save PayPal during checkout. Server-side only. */
  vaultId: string | null;
}

export interface CaptureInfo {
  captureId: string;
  status: PayPalCaptureStatus;
  amountMinor: number;
  currency: "USD";
  finalCapture: boolean;
}

export interface CreateOrderInput {
  dealId: string;
  contractId: string;
  /** Full 64-char terms hash. The provider stores it in custom_id so PayPal's record is bound to the contract. */
  contractHash: string;
  amountMinor: number;
  currency: "USD";
  /** <= 127 chars, shown to the payer. */
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Deterministic key → PayPal-Request-Id. Same key ⇒ same order. */
  idempotencyKey: string;
  /**
   * When set, the order is created against a vaulted PayPal wallet (delegated mode) and is
   * authorized in a single step with no payer interaction.
   */
  vaultId?: string;
}

export interface CaptureInput {
  authorizationId: string;
  /** Amount to capture, <= authorized amount. */
  amountMinor: number;
  currency: "USD";
  /** Always true in PACT: any uncaptured remainder is released back to the payer. */
  finalCapture: true;
  invoiceId: string;
  noteToPayer: string;
  idempotencyKey: string;
}

export interface VaultSetupInfo {
  setupTokenId: string;
  approveUrl: string;
}

export interface VaultTokenInfo {
  vaultId: string;
  payerEmailMasked: string | null;
}

export interface WebhookVerification {
  verified: boolean;
  /** "self" = local RSA/CRC32 verification, "postback" = PayPal verify-webhook-signature API. */
  method: "self" | "postback" | "simulated" | "none";
  reason: string | null;
}

export interface PaymentProvider {
  readonly kind: ProviderKind;
  /** True when Vault API calls are expected to work (credentials present / simulated). */
  readonly supportsVault: boolean;

  createOrder(input: CreateOrderInput): Promise<OrderInfo>;
  getOrder(orderId: string): Promise<OrderInfo>;
  /** Authorize an order the payer has approved. Idempotent on `idempotencyKey`. */
  authorizeOrder(orderId: string, idempotencyKey: string): Promise<OrderInfo>;
  getAuthorization(authorizationId: string): Promise<AuthorizationInfo>;
  captureAuthorization(input: CaptureInput): Promise<CaptureInfo>;
  voidAuthorization(authorizationId: string, idempotencyKey: string): Promise<void>;
  reauthorize(authorizationId: string, amountMinor: number, idempotencyKey: string): Promise<AuthorizationInfo>;

  createVaultSetup(input: { returnUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<VaultSetupInfo>;
  exchangeVaultSetup(setupTokenId: string, idempotencyKey: string): Promise<VaultTokenInfo>;

  /** Verify an incoming webhook. `rawBody` MUST be the exact bytes received. */
  verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookVerification>;
}

/**
 * Normalised payment error. `issue` is PayPal's `details[0].issue` when available
 * (e.g. ORDER_NOT_APPROVED, AUTHORIZATION_ALREADY_CAPTURED, INSTRUMENT_DECLINED).
 */
export class PaymentError extends Error {
  readonly issue: string;
  readonly httpStatus: number | null;
  /** PayPal's debug_id for support / log correlation. */
  readonly debugId: string | null;
  /** True for network errors, 5xx, 429 and PREVIOUS_REQUEST_IN_PROGRESS: safe to retry with the SAME idempotency key. */
  readonly retryable: boolean;

  constructor(args: {
    issue: string;
    message: string;
    httpStatus?: number | null;
    debugId?: string | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = "PaymentError";
    this.issue = args.issue;
    this.httpStatus = args.httpStatus ?? null;
    this.debugId = args.debugId ?? null;
    this.retryable = args.retryable ?? false;
  }
}

/** Persisted payment record (one per deal). All ids are PayPal's. */
export interface PaymentRecord {
  provider: ProviderKind;
  mode: ApprovalMode;
  status: import("../domain/status").PaymentStatus;
  orderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  /** Contract price. */
  amountMinor: number;
  authorizedMinor: number;
  capturedMinor: number;
  currency: "USD";
  approveUrl: string | null;
  authorizationExpiresAt: string | null;
  payerEmailMasked: string | null;
  lastError: { issue: string; message: string; debugId: string | null; at: string } | null;
  /** Which lifecycle events PayPal has independently confirmed via verified webhooks. */
  webhookConfirmed: { authorized: boolean; captured: boolean; voided: boolean };
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Idempotency ledger                                                         */
/* -------------------------------------------------------------------------- */

export type PaymentOperationKind =
  | "create_order"
  | "authorize"
  | "capture"
  | "void"
  | "reauthorize"
  | "vault_setup"
  | "vault_exchange";

export type LedgerBeginResult =
  /** First time this key is seen: the caller must perform the operation and then call succeed/fail. */
  | { state: "new" }
  /** A previous attempt completed successfully: reuse `response`, do NOT call PayPal again. */
  | { state: "succeeded"; response: Record<string, unknown> }
  /**
   * A previous attempt started but never recorded an outcome (crash / timeout), or failed with a
   * retryable error. The caller may retry with the SAME key: PayPal-Request-Id makes that safe.
   */
  | { state: "retry"; attempts: number }
  /** A previous attempt failed terminally. */
  | { state: "failed"; error: { issue: string; message: string; debugId: string | null } };

/**
 * Durable record of every money-moving call, keyed by the idempotency key that is also sent
 * to PayPal as PayPal-Request-Id. Implemented on Postgres (payment_operations) and in memory for tests.
 */
export interface PaymentLedger {
  begin(input: {
    key: string;
    dealId: string;
    kind: PaymentOperationKind;
    request: Record<string, unknown>;
  }): Promise<LedgerBeginResult>;
  succeed(key: string, response: Record<string, unknown>): Promise<void>;
  fail(
    key: string,
    error: { issue: string; message: string; debugId: string | null },
    options: { retryable: boolean },
  ): Promise<void>;
}

/** Storage used by the SimulatedProvider so simulated orders survive across requests. */
export interface SimulatedStore {
  load(id: string): Promise<Record<string, unknown> | null>;
  save(id: string, document: Record<string, unknown>): Promise<void>;
}
