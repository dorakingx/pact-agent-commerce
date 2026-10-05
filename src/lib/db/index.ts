/**
 * Persistence: the database client, typed errors and repositories.
 * Import from "@/lib/db" rather than from individual files.
 */
export {
  closeDb,
  createTestDb,
  databaseKind,
  getDb,
  withTransaction,
  type DatabaseKind,
  type Db,
  type QueryObserver,
} from "./client";
export { DbError, DuplicateError, isUniqueViolation } from "./errors";
export * from "./repos";
export type { DealInsert, DealRow, WalletRow, WebhookEventRow } from "./schema";
export { toIsoUtc } from "./time";
export { InvalidRecordError } from "./validation";
