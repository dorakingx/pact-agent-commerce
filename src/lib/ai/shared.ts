/**
 * Small helpers shared by the agent modules (intent parser, negotiators, verifier).
 *
 * Two concerns live here because every agent needs them the same way:
 *  - how untrusted text is fenced before it is shown to a model, and
 *  - how free-form model strings are normalised before they reach a domain schema.
 */
import { HOUR_MS, singleLine, truncate } from "../domain/format";
import { toPayPalValue } from "../domain/money";
import type { CallStructured } from "./gateway";

/** Injection point for tests: every agent function accepts a stubbed model call. */
export interface AgentDeps {
  call?: CallStructured;
}

/**
 * A model returned schema-valid output that still cannot be mapped onto a domain object
 * (for example an offer with no resolvable price). Callers treat it like an invalid model
 * output and fall back to the scripted agent.
 */
export class AgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentOutputError";
  }
}

/**
 * Fence a value as inert data for a prompt.
 *
 * JSON.stringify already neutralises quotes and newlines; angle brackets are escaped as well so
 * that nothing inside the data can reproduce the closing marker and "escape" the block.
 */
export function dataBlock(label: string, value: unknown): string {
  const json = JSON.stringify(value, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<<<${label}\n${json}\n${label}>>>`;
}

/** Collapse a free-form string to one clean, printable line of at most `max` characters. */
export function cleanLine(text: string, max: number): string {
  return truncate(singleLine(text), max);
}

/**
 * Agents speak plain prose. Models occasionally decorate messages with markdown anyway, which
 * the UI would render literally, so the decoration is removed rather than trusted to be absent.
 */
export function plainMessage(text: string, max: number): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*`]+|__/g, "")
    .replace(/^\s*(?:#{1,6}|>|[-•])\s+/gm, "");
  return cleanLine(stripped, max);
}

const HAS_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?)?/i;

/**
 * Parse a model-supplied timestamp. Models are asked for ISO-8601 UTC but sometimes omit the
 * zone; such a value is read as wall-clock time at `assumeOffsetMinutes` (Date#getTimezoneOffset
 * semantics, default UTC) instead of the server's own timezone, which would be arbitrary.
 */
export function parseInstant(value: string | null | undefined, assumeOffsetMinutes = 0): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (HAS_ZONE.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const m = LOCAL_DATE_TIME.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) + assumeOffsetMinutes * 60_000;
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Dollars as a plain number for LLM-facing JSON (4550 -> 45.5). The division stays in money.ts. */
export function usd(minor: number): number {
  return Number(toPayPalValue(minor));
}

/** Hours between two instants, rounded to one decimal, for prompts ("28.5 hours from now"). */
export function hoursBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / HOUR_MS) * 10) / 10;
}
