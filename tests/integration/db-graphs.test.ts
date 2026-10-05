import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDbLedger,
  createTestDb,
  DEAL_GRAPH_QUERY_COUNT,
  getContractByDeal,
  getDeal,
  getPayment,
  insertAuditEvent,
  insertContract,
  insertDeal,
  insertMove,
  insertReport,
  insertSubmission,
  listAuditEvents,
  listMoves,
  listPaymentOperations,
  listReports,
  listSubmissions,
  loadDealGraphs,
  upsertPayment,
  withTransaction,
  type Db,
  type DealGraph,
} from "@/lib/db";
import { deals } from "@/lib/db/schema";
import {
  auditFixture,
  contractFixture,
  dealFixture,
  moveFixture,
  paymentFixture,
  queryRows,
  reportFixture,
  submissionFixture,
} from "@/lib/db/test-fixtures";

describe("loadDealGraphs", () => {
  let db: Db;
  const statements: string[] = [];

  beforeAll(async () => {
    db = await createTestDb({ onQuery: (query) => statements.push(query) });
  });

  afterAll(async () => {
    await closeDb(db);
  });

  /** A deal with `rounds` deliveries and everything else a settled deal accumulates. */
  async function seedFullDeal(rounds: number): Promise<DealGraph> {
    const deal = await insertDeal(db, dealFixture({ status: "completed" }));
    const moves = [moveFixture(1), moveFixture(2), moveFixture(3, { action: "accept" })];
    const signed = contractFixture(deal.id);
    const payment = paymentFixture({ status: "captured", capturedMinor: 10_500, captureId: `CAP-${deal.id}` });
    const submissions = Array.from({ length: rounds }, (_, index) => submissionFixture(deal.id, index + 1));
    const reports = submissions.map((submission, index) =>
      reportFixture(deal.id, index + 1, {
        submissionId: submission.id,
        decision: index + 1 === rounds ? "capture_eligible" : "revision_required",
      }),
    );
    const audit = [1, 2, 3, 4].map((seq) => auditFixture(deal.id, seq));

    // Written out of order on purpose: the graph must come back sorted regardless.
    for (const move of [...moves].reverse()) await insertMove(db, deal.id, move);
    await insertContract(db, signed);
    await upsertPayment(db, deal.id, payment);
    for (const submission of [...submissions].reverse()) await insertSubmission(db, submission);
    for (const report of [...reports].reverse()) await insertReport(db, report);
    for (const event of [...audit].reverse()) await insertAuditEvent(db, event);

    return { deal, moves, signed, payment, submissions, reports, audit };
  }

  it("returns the complete graph of every requested deal", async () => {
    const settled = await seedFullDeal(2);
    const other = await seedFullDeal(1);
    const bare = await insertDeal(db, dealFixture());

    const graphs = await loadDealGraphs(db, [settled.deal.id, other.deal.id, bare.id]);

    expect(graphs.size).toBe(3);
    expect(graphs.get(settled.deal.id)).toEqual(settled);
    expect(graphs.get(other.deal.id)).toEqual(other);
    expect(graphs.get(bare.id)).toEqual({
      deal: bare,
      moves: [],
      signed: null,
      payment: null,
      submissions: [],
      reports: [],
      audit: [],
    });
  });

  it("agrees with the single-deal repository functions", async () => {
    const { deal } = await seedFullDeal(2);

    const graph = (await loadDealGraphs(db, [deal.id])).get(deal.id);

    expect(graph).toEqual({
      deal: await getDeal(db, deal.id),
      moves: await listMoves(db, deal.id),
      signed: await getContractByDeal(db, deal.id),
      payment: await getPayment(db, deal.id),
      submissions: await listSubmissions(db, deal.id),
      reports: await listReports(db, deal.id),
      audit: await listAuditEvents(db, deal.id),
    });
  });

  it("keeps the caller's order, ignores duplicates and omits unknown ids", async () => {
    const first = await insertDeal(db, dealFixture());
    const second = await insertDeal(db, dealFixture());
    const third = await insertDeal(db, dealFixture());

    const graphs = await loadDealGraphs(db, [third.id, "deal_missing", first.id, third.id, second.id]);

    expect([...graphs.keys()]).toEqual([third.id, first.id, second.id]);
  });

  it("issues the same fixed number of queries for one deal as for many", async () => {
    const many = await Promise.all(Array.from({ length: 12 }, () => seedFullDeal(2)));
    const ids = many.map((graph) => graph.deal.id);

    statements.length = 0;
    await loadDealGraphs(db, [ids[0]]);
    const forOne = statements.length;

    statements.length = 0;
    const graphs = await loadDealGraphs(db, ids);
    const forMany = statements.length;

    statements.length = 0;
    await loadDealGraphs(db, ids, { artifacts: false });
    const forManyWithoutBodies = statements.length;

    expect(graphs.size).toBe(12);
    expect(forOne).toBe(DEAL_GRAPH_QUERY_COUNT);
    expect(forMany).toBe(DEAL_GRAPH_QUERY_COUNT);
    expect(forManyWithoutBodies).toBe(DEAL_GRAPH_QUERY_COUNT);
  });

  it("does not query at all for an empty request", async () => {
    statements.length = 0;

    expect((await loadDealGraphs(db, [])).size).toBe(0);
    expect(statements).toEqual([]);
  });

  it("strips artifact bodies with { artifacts: false } but keeps everything else", async () => {
    const seeded = await seedFullDeal(2);

    statements.length = 0;
    const graph = (await loadDealGraphs(db, [seeded.deal.id], { artifacts: false })).get(seeded.deal.id);

    expect(graph?.submissions).toEqual(
      seeded.submissions.map((submission) => ({
        ...submission,
        artifacts: submission.artifacts.map((artifact) =>
          artifact.kind === "illustration" ? { ...artifact, svg: "" } : { ...artifact, text: "" },
        ),
      })),
    );
    // Nothing else about the graph changes.
    expect({ ...graph, submissions: seeded.submissions }).toEqual(seeded);
    // The bodies are removed by Postgres, not fetched and then discarded.
    const submissionQuery = statements.find((statement) => statement.includes('from "submissions"'));
    expect(submissionQuery).toContain("- 'svg' - 'text'");
    expect(submissionQuery).not.toContain('select "id", "deal_id", "round", "artifacts"');
  });

  it("handles a submission with no artifacts when stripping bodies", async () => {
    const deal = await insertDeal(db, dealFixture());
    const empty = submissionFixture(deal.id, 1, { artifacts: [] });
    await insertSubmission(db, empty);

    const graph = (await loadDealGraphs(db, [deal.id], { artifacts: false })).get(deal.id);

    expect(graph?.submissions).toEqual([empty]);
  });

  it("works on a transaction handle", async () => {
    const seeded = await seedFullDeal(1);

    const graph = await withTransaction(db, async (tx) => (await loadDealGraphs(tx, [seeded.deal.id])).get(seeded.deal.id));

    expect(graph).toEqual(seeded);
  });
});

describe("cascade delete", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("removes everything that hangs off a deal, and nothing that belongs to another deal", async () => {
    const doomed = await insertDeal(db, dealFixture());
    const survivor = await insertDeal(db, dealFixture());
    for (const deal of [doomed, survivor]) {
      await insertMove(db, deal.id, moveFixture(1));
      await insertContract(db, contractFixture(deal.id));
      await upsertPayment(db, deal.id, paymentFixture());
      await createDbLedger(db).begin({ key: `${deal.id}:capture`, dealId: deal.id, kind: "capture", request: {} });
      await insertSubmission(db, submissionFixture(deal.id, 1));
      await insertReport(db, reportFixture(deal.id, 1));
      await insertAuditEvent(db, auditFixture(deal.id, 1));
    }

    await db.delete(deals).where(eq(deals.id, doomed.id));

    expect(await getDeal(db, doomed.id)).toBeNull();
    expect((await loadDealGraphs(db, [doomed.id])).size).toBe(0);
    expect(await listPaymentOperations(db, doomed.id)).toEqual([]);
    const childTables = [
      "negotiation_moves",
      "contracts",
      "payments",
      "payment_operations",
      "submissions",
      "verification_reports",
      "audit_events",
    ];
    for (const table of childTables) {
      const rows = await queryRows<{ deal_id: string }>(db, sql`select deal_id from ${sql.identifier(table)}`);
      expect(rows.map((row) => row.deal_id), table).toEqual([survivor.id]);
    }
  });
});
