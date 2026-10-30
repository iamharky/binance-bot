// One owner, one password (scrypt hash in settings.auth, set with `npm run cli -- set-password`). Sessions are
// random ids in an HttpOnly, SameSite=Strict cookie; failed logins are throttled per IP.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_DAYS = 7;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const COOKIE = "bb_session";

export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 10) throw new Error("Use a password of at least 10 characters");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { algo: "scrypt", N: 16384, r: 8, p: 1, salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function verifyPassword(password, stored) {
  if (!stored || typeof password !== "string") return false;
  const expected = Buffer.from(stored.hash, "hex");
  const got = scryptSync(password, Buffer.from(stored.salt, "hex"), expected.length, { N: stored.N, r: stored.r, p: stored.p });
  return timingSafeEqual(expected, got);
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  constructor(store, { secureCookie = false, now = () => Date.now() } = {}) {
    this.store = store;
    this.secureCookie = secureCookie;
    this.now = now;
  }

  get passwordSet() {
    return this.store.getSetting("auth") !== null;
  }

  setPassword(password) {
    this.store.setSetting("auth", hashPassword(password));
    this.store.deleteAllSessions();
  }

  /** Returns {sessionId} or throws an Error with `status` (401 wrong password, 429 throttled, 503 no password). */
  login(password, ip, userAgent) {
    const now = this.now();
    if (!this.passwordSet) throw Object.assign(new Error("No password set: run npm run cli -- set-password"), { status: 503 });
    if (this.store.failedLogins(ip, now - FAILURE_WINDOW_MS) >= MAX_FAILURES) {
      throw Object.assign(new Error("Too many failed logins; try again in 15 minutes"), { status: 429 });
    }
    const ok = verifyPassword(password, this.store.getSetting("auth"));
    this.store.recordLogin(ip, now, ok);
    if (!ok) throw Object.assign(new Error("Wrong password"), { status: 401 });
    const id = randomBytes(32).toString("hex");
    this.store.insertSession({ id, createdAt: now, expiresAt: now + SESSION_DAYS * 86_400_000, ip, userAgent: String(userAgent ?? "").slice(0, 200) });
    return { sessionId: id };
  }

  /** The session of a request, or null. */
  session(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id) return null;
    const s = this.store.getSession(id);
    if (!s || s.expires_at < this.now()) {
      if (s) this.store.deleteSession(id);
      return null;
    }
    this.store.touchSession(id, this.now());
    return s;
  }

  logout(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (id) this.store.deleteSession(id);
  }

  cookie(sessionId) {
    const parts = [`${COOKIE}=${sessionId}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_DAYS * 86_400}`];
    if (this.secureCookie) parts.push("Secure");
    return parts.join("; ");
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie ? "; Secure" : ""}`;
  }
}
