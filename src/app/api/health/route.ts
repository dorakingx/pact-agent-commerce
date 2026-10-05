/**
 * GET /api/health — what is configured in this deployment (never the values), for uptime
 * checks and the status pill. Answers 200 even when the database is down; the failed
 * components are then listed under `degraded`.
 */
import { json, route } from "@/lib/services/http";
import { getSystemStatus } from "@/lib/services/system";

export const maxDuration = 60;

export const GET = route("health", async () => json(await getSystemStatus()));
