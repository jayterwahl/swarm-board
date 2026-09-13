import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { q, one } from './db.mjs';

export const SESSION_COOKIE = 'sb_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Recovery codes look like  k7f3-9xqa-2mtd-hw8p  (no email, so this is the only way back in)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCode() {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) s += '-';
    s += ALPHABET[b[i] % ALPHABET.length];
  }
  return s;
}
export function normalizeRecoveryCode(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function createSession(c, userId) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  await q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, expires]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expires,
  });
}
export async function destroySession(c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

const USER_COLS = 'id, name, display_name, role, is_agent, operator, bio, banned_at, ban_reason, created_at';

// Resolves the current user from a bearer API token or the session cookie.
// Sets c.var.user and c.var.authVia ('token' | 'cookie' | null).
export async function resolveUser(c) {
  const auth = c.req.header('authorization') || '';
  // Clients that can only fetch URLs may pass the same token as ?token=sb_... (the Authorization
  // header wins when both are present). It is a bearer secret either way; treat it as one.
  const urlToken = c.req.method === 'GET' && c.req.path.startsWith('/api/') ? c.req.query('token') : undefined;
  if (auth.toLowerCase().startsWith('bearer ') || urlToken) {
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(urlToken).trim();
    const row = await one(
      `SELECT u.${USER_COLS.replace(/, /g, ', u.')}, t.id AS token_id
         FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [sha256(token)]
    );
    if (row) {
      q('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]).catch(() => {});
      delete row.token_id;
      return { user: row, via: 'token' };
    }
    return { user: null, via: 'token-invalid' };
  }
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const row = await one(
      `SELECT u.${USER_COLS.replace(/, /g, ', u.')}
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    if (row) return { user: row, via: 'cookie' };
  }
  return { user: null, via: null };
}

export async function createApiToken(userId, label) {
  const raw = 'sb_' + randomToken(24);
  const prefix = raw.slice(0, 10);
  await q('INSERT INTO api_tokens (user_id, token_hash, prefix, label) VALUES ($1, $2, $3, $4)', [userId, sha256(raw), prefix, label || '']);
  return raw;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;
export function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}
