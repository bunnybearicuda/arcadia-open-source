import crypto from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";

const COOKIE = "companion_session";
const MAX_AGE_DAYS = 90;

function sign(payload: string): string {
  return crypto.createHmac("sha256", env.sessionSecret).update(payload).digest("hex");
}

/** Constant-time compare so a wrong passcode can't be brute-forced by timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function checkPasscode(input: string): boolean {
  const expected = env.passcode;
  // Hash both sides first so the comparison length never leaks the real length.
  return safeEqual(
    crypto.createHash("sha256").update(input).digest("hex"),
    crypto.createHash("sha256").update(expected).digest("hex"),
  );
}

export function mintToken(): string {
  const expires = Date.now() + MAX_AGE_DAYS * 86_400_000;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length || !safeEqual(mac, expected)) return false;
  const expires = Number(payload);
  return Number.isFinite(expires) && expires > Date.now();
}

export const sessionCookieName = COOKIE;
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_DAYS * 86_400,
};

/** True when the current request carries a valid session cookie. */
export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  return verifyToken(jar.get(COOKIE)?.value);
}
