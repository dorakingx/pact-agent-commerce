/**
 * Delegated agent wallets (PayPal vault tokens). The vault id is a credential: rows returned
 * from here must stay on the server and must never be logged or sent to the browser.
 */
import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { wallets, type WalletRow } from "../schema";
import { toIsoUtc } from "../time";

/**
 * Every column is required, including the nullable ones, so that an update can neither keep a
 * stale vault id by omission nor drop one by accident.
 */
export type WalletInput = Omit<WalletRow, "createdAt" | "updatedAt">;

export function getWallet(db: Db, owner: string): Promise<WalletRow | null> {
  return dbCall("getWallet", async () => {
    const [row] = await db.select().from(wallets).where(eq(wallets.owner, owner)).limit(1);
    return row ? { ...row, createdAt: toIsoUtc(row.createdAt), updatedAt: toIsoUtc(row.updatedAt) } : null;
  });
}

/** Creates the owner's wallet or replaces every field of it; `createdAt` is kept on replace. */
export function upsertWallet(db: Db, wallet: WalletInput): Promise<void> {
  return dbCall("upsertWallet", async () => {
    const now = new Date().toISOString();
    const fields = {
      provider: wallet.provider,
      status: wallet.status,
      setupTokenId: wallet.setupTokenId,
      vaultId: wallet.vaultId,
      payerEmailMasked: wallet.payerEmailMasked,
      updatedAt: now,
    };
    await db
      .insert(wallets)
      .values({ owner: wallet.owner, ...fields, createdAt: now })
      .onConflictDoUpdate({ target: wallets.owner, set: fields });
  });
}

/** Disconnects the wallet. Removing a wallet that does not exist is not an error. */
export function deleteWallet(db: Db, owner: string): Promise<void> {
  return dbCall("deleteWallet", async () => {
    await db.delete(wallets).where(eq(wallets.owner, owner));
  });
}
