/**
 * Public surface of the payments module, plus the one place that decides which provider is live.
 *
 * Import from here rather than from the individual files: the orchestrator functions are the
 * only way money moves, and the provider is only ever handed to them.
 */
import "server-only";
import { getPayPalConfig, getPaymentMode } from "../config";
import { createPayPalProviderFromEnv } from "./paypal-client";
import { SimulatedProvider } from "./simulated";
import type { PaymentProvider, SimulatedStore } from "./types";

interface ProviderMemo {
  /** Everything the provider was built from; a change (tests, rotated config) rebuilds it. */
  fingerprint: string;
  store: SimulatedStore | undefined;
  provider: PaymentProvider;
}

type ProviderScope = typeof globalThis & { __pactPaymentProvider?: ProviderMemo };

/**
 * The active payment provider: PayPal Sandbox whenever credentials are configured, otherwise the
 * labelled simulator. Memoised on globalThis so the PayPal access token (and the simulator's
 * in-memory state) survive Next.js dev module reloads and are shared by every route.
 *
 * `simulatedStore` only matters for the simulator: pass the database-backed store so simulated
 * orders outlive a single serverless instance.
 */
export function getPaymentProvider(deps: { simulatedStore?: SimulatedStore } = {}): PaymentProvider {
  const scope = globalThis as ProviderScope;
  const config = getPaymentMode() === "paypal_sandbox" ? getPayPalConfig() : null;
  // The secret is deliberately not part of the fingerprint: it must never be copied into a string that outlives the config.
  const fingerprint =
    config === null ? "simulated" : `paypal_sandbox|${config.clientId}|${config.apiBase}|${config.webhookId ?? ""}`;
  const memo = scope.__pactPaymentProvider;
  if (memo !== undefined && memo.fingerprint === fingerprint && (config !== null || memo.store === deps.simulatedStore)) {
    return memo.provider;
  }
  const provider: PaymentProvider =
    (config === null ? null : createPayPalProviderFromEnv()) ?? new SimulatedProvider(deps.simulatedStore);
  scope.__pactPaymentProvider = { fingerprint, store: deps.simulatedStore, provider };
  return provider;
}

export { idempotencyKey } from "./idempotency";
export { createMemoryLedger, type LedgerEntryStatus, type MemoryLedger, type MemoryLedgerEntry } from "./ledger";
export { maskEmail } from "./mask";
export {
  PaymentStepError,
  authorizeApprovedOrder,
  captureVerified,
  newPaymentRecord,
  openOrder,
  reconcile,
  voidHeldFunds,
  type OrchestratorDeps,
  type PaymentStepResult,
  type ReconcileResult,
} from "./orchestrator";
export { PayPalSandboxProvider, createPayPalProviderFromEnv, type PayPalClientOptions } from "./paypal-client";
export {
  SimulatedProvider,
  createMemorySimulatedStore,
  simulatedApprovePath,
  type SimulatedCheckout,
} from "./simulated";
export {
  SUBSCRIBED_EVENT_TYPES,
  applyWebhookEffect,
  interpretWebhookEvent,
  type WebhookApplication,
  type WebhookEffect,
} from "./webhook";
export { PaymentError } from "./types";
export type {
  ApprovalMode,
  AuthorizationInfo,
  CaptureInfo,
  CaptureInput,
  CreateOrderInput,
  LedgerBeginResult,
  OrderInfo,
  PaymentLedger,
  PaymentOperationKind,
  PaymentProvider,
  PaymentRecord,
  ProviderKind,
  SimulatedStore,
  VaultSetupInfo,
  VaultTokenInfo,
  WebhookVerification,
} from "./types";
