/**
 * Anonymous sessions. The public demo has no accounts: each browser gets a random session id in
 * a signed, http-only cookie, and that id owns the deals it creates. Only the owner may advance
 * a deal or decide at a human gate.
 */
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getSessionSecret } from "../config";

export const SESSION_COOKIE = "pact_sid";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const ID_PATTERN = /^sess_[a-z0-9]{24}$/;

/** Owner of seeded showcase deals. Can never be a browser session (it does not match ID_PATTERN). */
export const SYSTEM_OWNER = "system";

function sign(id: string, secret: string): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

export function newSessionId(): string {
  // 24 chars of [0-9a-z] ≈ 124 bits.
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(24);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `sess_${out}`;
}

export function signSession(id: string, secret: string): string {
  return `${id}.${sign(id, secret)}`;
}

/** Returns the session id if the cookie value is well-formed and its signature verifies, else null. */
export function verifySession(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!ID_PATTERN.test(id)) return null;
  const expected = Buffer.from(sign(id, secret));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? id : null;
}

/** The current session id, or null if the request carries no valid session cookie. */
export async function readSession(): Promise<string | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value, getSessionSecret());
}

/** The current session id, creating the session (and setting the cookie) if there is none. Route handlers only. */
export async function ensureSession(): Promise<string> {
  const store = await cookies();
  const secret = getSessionSecret();
  const existing = verifySession(store.get(SESSION_COOKIE)?.value, secret);
  if (existing) return existing;
  const id = newSessionId();
  store.set(SESSION_COOKIE, signSession(id, secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return id;
}
