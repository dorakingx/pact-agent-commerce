/** Signed contracts: one immutable, hashed document per deal. */
import "server-only";
import { eq } from "drizzle-orm";
import { SignedContractSchema, type SignedContract } from "../../domain/schemas";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { contracts, type ContractRow } from "../schema";
import { toIsoUtc } from "../time";
import { parseForWrite, parseStored } from "../validation";

/**
 * Returns the document exactly as it was stored. The terms hash covers the canonical JSON of
 * the contract, so the validated-but-untouched document is returned rather than a re-parsed copy.
 */
export function toSignedContract(row: ContractRow): SignedContract {
  parseStored(SignedContractSchema, row.document, `contract ${row.id} of deal ${row.dealId}`);
  return row.document;
}

/** Throws DuplicateError when the deal already has a contract: a contract is never replaced. */
export function insertContract(db: Db, signed: SignedContract): Promise<void> {
  return dbCall("insertContract", async () => {
    // Validated first, stored verbatim: see toSignedContract.
    parseForWrite(SignedContractSchema, signed, "signed contract");
    const { contract } = signed;
    await db.insert(contracts).values({
      id: contract.contractId,
      dealId: contract.dealId,
      termsHash: signed.termsHash,
      document: signed,
      createdAt: toIsoUtc(contract.createdAt),
    });
  });
}

export function getContractByDeal(db: Db, dealId: string): Promise<SignedContract | null> {
  return dbCall("getContractByDeal", async () => {
    const [row] = await db.select().from(contracts).where(eq(contracts.dealId, dealId)).limit(1);
    return row ? toSignedContract(row) : null;
  });
}
