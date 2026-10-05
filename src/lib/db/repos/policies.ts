/** Spending policy documents, one per owner. Evaluation is the policy engine's job, not this file's. */
import "server-only";
import { eq } from "drizzle-orm";
import { PolicySchema, type Policy } from "../../domain/schemas";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { policies } from "../schema";
import { parseForWrite, parseStored } from "../validation";

/** Null when the owner has never saved a policy; the caller decides which default applies. */
export function getPolicyDoc(db: Db, owner: string): Promise<Policy | null> {
  return dbCall("getPolicyDoc", async () => {
    const [row] = await db.select().from(policies).where(eq(policies.owner, owner)).limit(1);
    return row ? parseStored(PolicySchema, row.document, `policy of owner ${owner}`) : null;
  });
}

export function upsertPolicyDoc(db: Db, owner: string, policy: Policy): Promise<void> {
  return dbCall("upsertPolicyDoc", async () => {
    const document = parseForWrite(PolicySchema, policy, `policy of owner ${owner}`);
    const updatedAt = new Date().toISOString();
    await db
      .insert(policies)
      .values({ owner, document, updatedAt })
      .onConflictDoUpdate({ target: policies.owner, set: { document, updatedAt } });
  });
}
