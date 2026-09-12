import { getDatabase } from '@netlify/database';

let db;
function pool() {
  db ??= getDatabase();
  return db.pool;
}

export function q(text, params = []) {
  return pool().query(text, params);
}
export async function one(text, params = []) {
  const r = await q(text, params);
  return r.rows[0] ?? null;
}
export async function all(text, params = []) {
  const r = await q(text, params);
  return r.rows;
}
export async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}
export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
