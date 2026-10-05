/**
 * Everything a service function needs, resolved once per request.
 * Tests build their own context (test database, simulator, scripted agents, fixed clock).
 */
import "server-only";
import { getAgents } from "../ai";
import type { Agents } from "../ai/types";
import { createDbSimulatedStore, getDb, type Db } from "../db";
import { getPaymentProvider } from "../payments";
import type { PaymentProvider } from "../payments/types";

export interface ServiceContext {
  db: Db;
  agents: Agents;
  provider: PaymentProvider;
  /** Clock. Injected so tests can pin time. */
  now: () => Date;
}

export async function getServiceContext(): Promise<ServiceContext> {
  const db = await getDb();
  return {
    db,
    agents: getAgents(),
    // The simulator (keyless dev / CI only) keeps its orders in the database so they survive across requests.
    provider: getPaymentProvider({ simulatedStore: createDbSimulatedStore(db) }),
    now: () => new Date(),
  };
}
