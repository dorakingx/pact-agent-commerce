/**
 * Repositories: thin, typed storage functions. Each takes a `Db` first, so the same function
 * works on the root database and inside a transaction. They hold no business rules — no
 * hashing, no state machine, no policy; those belong to the service layer and its engines.
 */
export { getLastAuditEvent, insertAuditEvent, listAuditEvents } from "./audit";
export { findDealIdByContractBinding, getContractByDeal, insertContract } from "./contracts";
export {
  acquireDealLease,
  countDealsCreatedSince,
  getDeal,
  getDealByCode,
  insertDeal,
  listDealsByOwner,
  listDealsForOwners,
  listStalledDealIds,
  releaseDealLease,
  sumAuthorizedSince,
  updateDeal,
} from "./deals";
export { insertReport, insertSubmission, listReports, listSubmissions } from "./deliveries";
export { DEAL_GRAPH_QUERY_COUNT, loadDealGraphs, type DealGraph, type LoadDealGraphsOptions } from "./graphs";
export {
  createDbLedger,
  listPaymentOperations,
  PAYMENT_OPERATION_STATUSES,
  type PaymentOperation,
  type PaymentOperationStatus,
} from "./ledger";
export { insertMove, listMoves } from "./negotiation";
export {
  findDealIdByAuthorizationId,
  findDealIdByCaptureId,
  findDealIdByOrderId,
  getPayment,
  getPaymentFunding,
  setPaymentFunding,
  upsertPayment,
} from "./payments";
export { getPolicyDoc, upsertPolicyDoc } from "./policies";
export { deleteStaleRateLimits, hitRateLimit, type RateLimitResult } from "./rate-limit";
export { createDbSimulatedStore } from "./simulator";
export { deleteWallet, getWallet, upsertWallet, type WalletInput } from "./wallets";
export {
  getWebhookEvent,
  markWebhookProcessed,
  recordWebhookEvent,
  type WebhookEventInput,
  type WebhookRecordResult,
} from "./webhooks";
