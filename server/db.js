// SQLite (Node 내장 node:sqlite) — 별도 DB 서버가 필요 없습니다.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const file = process.env.DB_FILE || "./data/chat.db";
if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  last_chat_at INTEGER
);
CREATE INDEX IF NOT EXISTS characters_user ON characters(user_id);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_char ON chats(char_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, seq);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);

export const uid = () => Date.now().toString(36) + randomBytes(6).toString("hex");

export function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
