"use client";

import { useCallback } from "react";
import useSWR from "swr";
import type { SystemStatus } from "../api/dto";
import { fetcher, type ApiClientError } from "./api";

export const HEALTH_KEY = "/api/health";
/** How often an open page re-reads the health endpoint. */
export const HEALTH_REFRESH_MS = 60_000;

export type SystemStatusGroup = "payments" | "agents" | "platform";

export interface SystemStatusRow {
  id: string;
  group: SystemStatusGroup;
  label: string;
  value: string;
  /** Why the value is what it is, in one sentence. */
  detail: string | null;
  tone: "success" | "hold" | "neutral" | "danger";
  /** The value is an identifier (a model id, a version) and reads best in monospace. */
  mono: boolean;
}

export interface SystemStatusView {
  provider: SystemStatus["payments"]["provider"];
  ai: SystemStatus["ai"]["mode"];
  /** One sentence per component the health endpoint reported as degraded. Empty when healthy. */
  problems: string[];
  rows: SystemStatusRow[];
}

export const SYSTEM_STATUS_GROUP_LABEL: Record<SystemStatusGroup, string> = {
  payments: "Payments",
  agents: "Agents",
  platform: "Platform",
};

type Row = Omit<SystemStatusRow, "mono"> & { mono?: boolean };

function paymentRail(status: SystemStatus, misconfigured: boolean): Row {
  const base = { id: "payment-rail", group: "payments", label: "Payment rail" } as const;
  if (misconfigured) {
    return {
      ...base,
      value: "Misconfigured",
      detail: "PayPal credentials are present but cannot be used. No payment can be started until that is fixed.",
      tone: "danger",
    };
  }
  if (status.payments.provider === "paypal_sandbox") {
    return {
      ...base,
      value: "PayPal Sandbox · live",
      detail: "Payments are real PayPal Sandbox API calls. No real money moves.",
      tone: "success",
    };
  }
  return {
    ...base,
    value: "Simulated",
    detail: status.payments.configured
      ? "PayPal credentials are present, but this deployment is set to use the in-process simulator."
      : "No PayPal credentials are configured, so an in-process simulator stands in for PayPal.",
    tone: "hold",
  };
}

function webhooks(status: SystemStatus): Row {
  const base = { id: "webhooks", group: "payments", label: "Webhook verification" } as const;
  if (status.payments.provider === "simulated") {
    return { ...base, value: "Not used", detail: "The simulator settles in-process and sends no webhooks.", tone: "neutral" };
  }
  return status.payments.webhooks
    ? {
        ...base,
        value: "Signatures verified",
        detail: "A PayPal event is trusted only after PayPal confirms its signature.",
        tone: "success",
      }
    : {
        ...base,
        value: "Not configured",
        detail: "No webhook id is set, so PayPal events are ignored. Each step is confirmed from PayPal’s API responses.",
        tone: "hold",
      };
}

function demoWallet(status: SystemStatus, databaseDown: boolean): Row {
  const base = { id: "demo-wallet", group: "payments", label: "Delegated demo wallet" } as const;
  if (databaseDown) {
    return { ...base, value: "Unknown", detail: "The database could not be reached to check it.", tone: "danger" };
  }
  return status.payments.delegatedWallet
    ? { ...base, value: "Connected", detail: "In-policy deals authorize without a PayPal login.", tone: "success" }
    : {
        ...base,
        value: "Not connected",
        detail: "The payer approves each authorization, unless a session connects its own wallet.",
        tone: "neutral",
      };
}

function agents(status: SystemStatus): Row[] {
  if (status.ai.mode === "scripted") {
    return [
      {
        id: "agents",
        group: "agents",
        label: "Agents",
        value: "Scripted agents",
        detail: "No model calls are made. The agents follow deterministic scripts.",
        tone: "hold",
      },
    ];
  }
  const model = (id: string, label: string, value: string): Row => ({
    id,
    group: "agents",
    label,
    value,
    detail: null,
    tone: "neutral",
    mono: true,
  });
  return [
    model("buyer-model", "Buyer agent", status.ai.buyerModel),
    model("seller-model", "Seller agent", status.ai.sellerModel),
    model("verifier-model", "Verifier", status.ai.verifierModel),
  ];
}

const DATABASE_LABEL: Record<SystemStatus["database"], string> = {
  postgres: "Postgres",
  pglite: "PGlite (in-process Postgres)",
};

/** Turn the health report into what the status pill and its popover show. Pure, so it is unit-tested. */
export function describeSystemStatus(status: SystemStatus): SystemStatusView {
  const degraded = status.degraded ?? [];
  const databaseDown = degraded.includes("database");
  const misconfigured = degraded.includes("payments");

  const problems: string[] = [];
  if (databaseDown) problems.push("The database is not answering. Deals cannot be read or advanced right now.");
  if (misconfigured) problems.push("The PayPal configuration is invalid. No payment can be started.");

  const rows: Row[] = [
    paymentRail(status, misconfigured),
    webhooks(status),
    demoWallet(status, databaseDown),
    ...agents(status),
    {
      id: "database",
      group: "platform",
      label: "Database",
      value: databaseDown ? `${DATABASE_LABEL[status.database]} · unreachable` : DATABASE_LABEL[status.database],
      detail: null,
      tone: databaseDown ? "danger" : "neutral",
    },
    { id: "version", group: "platform", label: "Version", value: `v${status.version}`, detail: null, tone: "neutral", mono: true },
  ];

  return {
    provider: status.payments.provider,
    ai: status.ai.mode,
    problems,
    rows: rows.map((row) => ({ ...row, mono: row.mono ?? false })),
  };
}

export interface UseSystemStatus {
  /** The last health report received. Kept while a later refresh fails, so the pill does not flicker. */
  status: SystemStatus | undefined;
  error: ApiClientError | undefined;
  isLoading: boolean;
  /** A request is in flight, first load or refresh. */
  isRefreshing: boolean;
  reload: () => void;
}

/** What is real in this deployment (GET /api/health), refreshed every minute while the page is open. */
export function useSystemStatus(): UseSystemStatus {
  const { data, error, isLoading, isValidating, mutate } = useSWR<SystemStatus, ApiClientError>(HEALTH_KEY, fetcher, {
    refreshInterval: HEALTH_REFRESH_MS,
    // Several pills can be mounted at once (header and navigation drawer); one request serves them all.
    dedupingInterval: 10_000,
    // The health endpoint answers 200 even when degraded; a thrown error is a network problem and not worth hammering.
    errorRetryCount: 2,
  });

  const reload = useCallback(() => {
    void mutate();
  }, [mutate]);

  return { status: data, error, isLoading, isRefreshing: isValidating, reload };
}
