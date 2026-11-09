import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

const SESSION_DAYS = 30;
export const COOKIE = "cmm_session";

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = stored.split("$");
  const hash = Buffer.from(hashHex, "hex");
  const test = scryptSync(pw, Buffer.from(saltHex, "hex"), hash.length);
  return timingSafeEqual(hash, test);
}

export function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const maxAge = SESSION_DAYS * 864e5;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, Date.now() + maxAge);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  return { token, maxAge };
}

export function cookieOptions(req, maxAge) {
  return { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge };
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// 로그인한 사용자만 통과
export function requireUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.settings, u.is_admin FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, Date.now());
    if (row) {
      req.user = { id: row.id, username: row.username, isAdmin: !!row.is_admin, settings: JSON.parse(row.settings) };
      req.sessionToken = token;
      return next();
    }
  }
  res.status(401).json({ error: "로그인이 필요합니다." });
}

// 메모리 기반 시도 횟수 제한 (로그인·가입 무차별 대입 방지)
const attempts = new Map();
export function limitAttempts(max = 10, windowMs = 10 * 60e3) {
  return (req, res, next) => {
    const now = Date.now();
    const list = (attempts.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: "시도가 너무 많습니다. 잠시 후 다시 시도하세요." });
    list.push(now);
    attempts.set(req.ip, list);
    next();
  };
}
