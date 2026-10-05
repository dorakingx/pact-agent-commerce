/**
 * Pure mappings from stored deals to what the browser is shown.
 *
 * Nothing here reads a clock, a database or the environment: the same graph always produces the
 * same view, which is what lets the UI trust "what the screen says" to be "what is stored".
 * The view carries no secret — no vault id, no seller floor, no session id — and the buyer's
 * private mandate only for the session that owns the deal.
 */
import type { DealSummary, DealView } from "../api/dto";
import type { DealGraph, DealRow } from "../db";
import { verifyAuditChain } from "../domain/audit";
import { assertNever, singleLine, truncate } from "../domain/format";
import { MAX_MOVES, nextActor } from "../domain/negotiation";
import { nextStepFor } from "../domain/next-step";
import type { Artifact, Mandate, NegotiationMove, NegotiationState, Party } from "../domain/schemas";
import { getSeller, toSellerPublic } from "../domain/sellers";
import { DEAL_STATUS_LABEL } from "../domain/status";
import type { ProviderKind } from "../payments/types";
import { SYSTEM_OWNER } from "./session";

const SUMMARY_TITLE_MAX = 90;

export interface DealViewOptions {
  /**
   * The payment provider that will handle this deal's payment. Only consulted while the deal has
   * no payment record yet, so the "simulated" label is honest from the first screen on.
   */
  providerKind?: ProviderKind;
}

/** The seller's opening offer is its list price; everything negotiated after it is the saving. */
function listPriceOf(moves: readonly NegotiationMove[]): number | null {
  const opening = moves.find((move) => move.actor === "seller" && move.terms !== null);
  return opening?.terms?.priceMinor ?? null;
}

/** Whose move is due. Only a deal that is still negotiating has one. */
function nextNegotiator(deal: DealRow, moves: NegotiationMove[]): Party | null {
  if (deal.status !== "negotiating") return null;
  const state: NegotiationState = { status: "open", moves, agreedTerms: null, failureReason: null };
  return nextActor(state);
}

/**
 * The mandate holds the buyer's private ceiling. It is shown to the session that owns the deal,
 * and on showcase deals, which exist to be read by everyone.
 */
function visibleMandate(deal: DealRow, isOwner: boolean): Mandate | null {
  return isOwner || deal.owner === SYSTEM_OWNER ? deal.mandate : null;
}

/**
 * Map a deal graph to the deal view.
 *
 * @param viewerSessionId  The browser session asking, or null for an anonymous reader.
 * @param now              Accepted for the callers' fixed signature; no field of the view is
 *                         derived from the current time, which keeps a stored deal's view stable.
 */
export function buildDealView(
  graph: DealGraph,
  viewerSessionId: string | null,
  now: Date,
  options: DealViewOptions = {},
): DealView {
  const { deal, moves, signed, payment } = graph;
  const isOwner = viewerSessionId !== null && viewerSessionId === deal.owner;
  const seller = deal.sellerId === null ? undefined : getSeller(deal.sellerId);
  const revisions = { used: deal.revisionsUsed, limit: deal.revisionLimit ?? 0 };

  return {
    id: deal.id,
    code: deal.code,
    status: deal.status,
    statusLabel: DEAL_STATUS_LABEL[deal.status],
    scenarioId: deal.scenarioId,
    intent: deal.intent,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
    isOwner,
    seller: seller ? toSellerPublic(seller) : null,
    mandate: visibleMandate(deal, isOwner),
    negotiation: {
      status: deal.negotiationStatus,
      moves,
      agreedTerms: deal.agreedTerms,
      failureReason: deal.negotiationFailure,
      maxMoves: MAX_MOVES,
      listPriceMinor: listPriceOf(moves),
    },
    contract: signed ? { ...signed, paymentState: payment?.status ?? "none" } : null,
    policy: deal.policyEvaluation,
    payment,
    submissions: graph.submissions,
    reports: graph.reports,
    audit: graph.audit,
    revisions,
    humanDecision: deal.humanDecision,
    next: nextStepFor({
      status: deal.status,
      nextNegotiator: nextNegotiator(deal, moves),
      revisionsUsed: revisions.used,
      revisionLimit: revisions.limit,
    }),
    flags: {
      aiDegraded: deal.aiDegraded,
      simulatedPayment: (payment?.provider ?? options.providerKind) === "simulated",
      auditChainValid: verifyAuditChain(graph.audit).valid,
    },
    lastError: deal.lastError,
  };
}

/** One line for lists: the buyer agent's restatement of the task, or the request itself. */
export function toDealSummary(deal: DealRow): DealSummary {
  const seller = deal.sellerId === null ? undefined : getSeller(deal.sellerId);
  return {
    id: deal.id,
    code: deal.code,
    title: deal.mandate?.summary ?? truncate(singleLine(deal.intent), SUMMARY_TITLE_MAX),
    status: deal.status,
    statusLabel: DEAL_STATUS_LABEL[deal.status],
    scenarioId: deal.scenarioId,
    sellerName: seller?.name ?? null,
    priceMinor: deal.priceMinor,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/*  Deliverables as files                                                      */
/* -------------------------------------------------------------------------- */

export interface ArtifactFile {
  /** Safe for a Content-Disposition header: letters, digits, dash and underscore, then one dot and the extension. */
  filename: string;
  contentType: string;
  body: string;
}

const FILENAME_MAX = 80;

/**
 * Seller-supplied labels end up in the name, so everything outside a small alphabet is replaced.
 * The stem carries no dot at all: the only one in the name is the one before the extension.
 */
function safeFilename(stem: string, extension: string): string {
  const cleaned = stem
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${(cleaned === "" ? "deliverable" : cleaned).slice(0, FILENAME_MAX)}.${extension}`;
}

/** A deliverable as a downloadable file. The content is served exactly as stored (sanitised SVG or plain text). */
export function toArtifactFile(dealCode: string, artifact: Artifact): ArtifactFile {
  switch (artifact.kind) {
    case "illustration":
      return {
        filename: safeFilename(`${dealCode}-illustration-${artifact.index}-${artifact.aspectRatio.replace(":", "x")}`, "svg"),
        contentType: "image/svg+xml",
        body: artifact.svg,
      };
    case "copy":
      return {
        filename: safeFilename(`${dealCode}-copy-${artifact.index}-${artifact.language}`, "txt"),
        contentType: "text/plain; charset=utf-8",
        body: artifact.text,
      };
    default:
      return assertNever(artifact);
  }
}
