/**
 * What is switched on in this deployment, for the health endpoint and the status pill in the UI.
 *
 * It reports THAT integrations are configured, never their values: no credential, no id, no
 * URL. It must also answer when something is broken — that is when it is needed most — so
 * every probe is bounded and a failed probe is reported under `degraded` instead of thrown.
 */
import "server-only";
import type { SystemStatus } from "../api/dto";
import { APP_VERSION, getAiMode, getModelConfig, getPayPalConfig, getPaymentMode, type PayPalConfig } from "../config";
import { databaseKind, getDb, getWallet, type Db } from "../db";
import { log } from "../observability/logger";
import type { ProviderKind } from "../payments";
import { DEMO_WALLET_OWNER } from "./deals";
import { isActiveWallet } from "./wallet";

/** A component that could not be checked or is misconfigured. */
export type DegradedComponent = NonNullable<SystemStatus["degraded"]>[number];

/** What the health endpoint answers: SystemStatus, whose `degraded` lists the components that are not healthy. */
export type SystemStatusReport = SystemStatus;

export interface SystemStatusDeps {
  /** Opens the database; injected so tests can simulate one that is down or hangs. */
  openDb?: () => Promise<Db>;
  /** How long the database may take before the status is reported without it. */
  dbTimeoutMs?: number;
}

/** A health check that waits on a dead database is itself dead; stay well inside a probe's patience. */
const DEFAULT_DB_TIMEOUT_MS = 2_500;

interface PaymentsProbe {
  provider: ProviderKind;
  config: PayPalConfig | null;
  healthy: boolean;
}

/** The configuration can be invalid (a non-Sandbox API base is refused): report that, do not throw. */
function probePayments(): PaymentsProbe {
  try {
    // Credentials count as configured even while the simulator is forced (PACT_PAYMENT_MODE).
    return { provider: getPaymentMode(), config: getPayPalConfig(), healthy: true };
  } catch (error) {
    log.error("system.payments_misconfigured", { error });
    // Credentials are present but unusable; saying "simulated" would hide the misconfiguration.
    return { provider: "paypal_sandbox", config: null, healthy: false };
  }
}

class ProbeTimeout extends Error {}

function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeout(`no answer within ${timeoutMs} ms`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Whether the shared demo wallet is usable — which also proves the database answers. */
async function probeDelegatedWallet(provider: ProviderKind, deps: SystemStatusDeps): Promise<boolean | null> {
  const lookup = async (): Promise<boolean> => {
    const db = await (deps.openDb ?? getDb)();
    return isActiveWallet(await getWallet(db, DEMO_WALLET_OWNER), provider);
  };
  try {
    return await within(lookup(), deps.dbTimeoutMs ?? DEFAULT_DB_TIMEOUT_MS);
  } catch (error) {
    log.error("system.database_unreachable", { timedOut: error instanceof ProbeTimeout, error });
    return null;
  }
}

export async function getSystemStatus(deps: SystemStatusDeps = {}): Promise<SystemStatusReport> {
  const payments = probePayments();
  const delegatedWallet = await probeDelegatedWallet(payments.provider, deps);
  const models = getModelConfig();
  const degraded: DegradedComponent[] = [];
  if (delegatedWallet === null) degraded.push("database");
  if (!payments.healthy) degraded.push("payments");

  return {
    payments: {
      provider: payments.provider,
      configured: payments.config !== null,
      webhooks: payments.config?.webhookId !== undefined,
      delegatedWallet: delegatedWallet ?? false,
    },
    ai: {
      mode: getAiMode(),
      buyerModel: models.buyer,
      sellerModel: models.seller,
      verifierModel: models.verifier,
    },
    database: databaseKind(),
    version: APP_VERSION,
    ...(degraded.length === 0 ? {} : { degraded }),
  };
}
