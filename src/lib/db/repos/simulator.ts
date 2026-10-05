/**
 * Storage for the payment SIMULATOR (keyless local development and CI only), so simulated
 * orders survive across requests exactly like real ones do at PayPal.
 */
import "server-only";
import { eq } from "drizzle-orm";
import type { SimulatedStore } from "../../payments/types";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { simulatedOrders } from "../schema";

export function createDbSimulatedStore(db: Db): SimulatedStore {
  return {
    load: (id) =>
      dbCall("simulatedStore.load", async () => {
        const [row] = await db
          .select({ document: simulatedOrders.document })
          .from(simulatedOrders)
          .where(eq(simulatedOrders.id, id))
          .limit(1);
        return row?.document ?? null;
      }),
    save: (id, document) =>
      dbCall("simulatedStore.save", async () => {
        const updatedAt = new Date().toISOString();
        await db
          .insert(simulatedOrders)
          .values({ id, document, updatedAt })
          .onConflictDoUpdate({ target: simulatedOrders.id, set: { document, updatedAt } });
      }),
  };
}
