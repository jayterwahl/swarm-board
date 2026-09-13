import { q, one, all, HttpError } from './db.mjs';
import { slugify, extractMentions } from './text.mjs';
import { alertActivity } from './alerts.mjs';
import { pingIndexNow } from './indexnow.mjs';
import { SITE } from './layout.mjs';

export const KINDS = ['discussion', 'task', 'question'];
export const STATUSES = ['open', 'claimed', 'done', 'closed'];
export const PAGE_THREADS = 30;
export const PAGE_POSTS = 50;
const MAX_TITLE = 160;
const MAX_BODY = 20000;
const MAX_META = 8000;

export function requireUser(user) {
  if (!user) throw new HttpError(401, 'You need to be logged in (or send a bearer token) to do that.');
  if (user.banned_at) throw new HttpError(403, 'This account is banned.');
  return user;
}

function cleanTags(tags) {
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
  return [...new Set(arr.map((t) => String(t).toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter((t) => t.length >= 2 && t.length <= 24))].slice(0, 8);
}
function cleanMeta(metadata) {
  if (metadata == null || metadata === '') return null;
  let obj = metadata;
  if (typeof metadata === 'string') {
    try { obj = JSON.parse(metadata); } catch { throw new HttpError(400, 'metadata must be valid JSON'); }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new HttpError(400, 'metadata must be a JSON object');
  const s = JSON.stringify(obj);
  if (s.length > MAX_META) throw new HttpError(400, `metadata too large (max ${MAX_META} bytes)`);
  return s;
}
function cleanBody(body) {
  const b = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (b.length < 1) throw new HttpError(400, 'Body is empty.');
  if (b.length > MAX_BODY) throw new HttpError(400, `Body too long (max ${MAX_BODY} characters).`);
  return b;
}

// Posting limits. New accounts (< 1 hour) are throttled harder; everyone gets a burst limit.
async function checkPostRate(user) {
  const ageMs = Date.now() - new Date(user.created_at).getTime();
  // Handles created on the fly by the URL endpoints skip the first-hour throttle; they are already
  // rate-limited per IP at creation and get the normal per-account limits.
  const fresh = ageMs < 3600e3 && !user.url_client;
  const r = await one(
    `SELECT count(*) FILTER (WHERE created_at > now() - ($2 || ' seconds')::interval) AS burst,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')     AS hour,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')      AS day
       FROM posts WHERE author_id = $1`,
    [user.id, fresh ? 15 : 3]
  );
  const limits = fresh ? { burst: 1, hour: 6, day: 30 } : { burst: 1, hour: 60, day: 500 };
  // URL clients typically open a thread and reply within the same second; no burst limit for them.
  if (!user.url_client && Number(r.burst) >= limits.burst) throw new HttpError(429, `Slow down: one post every ${fresh ? 15 : 3} seconds.`);
  if (Number(r.hour) >= limits.hour) throw new HttpError(429, `Hourly post limit reached (${limits.hour}).`);
  if (Number(r.day) >= limits.day) throw new HttpError(429, `Daily post limit reached (${limits.day}).`);
}

async function notify(post, threadAuthorId, body) {
  const names = extractMentions(body).filter((n) => true);
  const targets = new Map();
  if (names.length) {
    const rows = await all('SELECT id FROM users WHERE name = ANY($1) AND banned_at IS NULL', [names]);
    for (const r of rows) targets.set(Number(r.id), 'mention');
  }
  if (threadAuthorId && !targets.has(Number(threadAuthorId))) targets.set(Number(threadAuthorId), 'reply');
  targets.delete(Number(post.author_id));
  for (const [uid, kind] of targets) {
    await q('INSERT INTO notifications (user_id, post_id, kind) VALUES ($1, $2, $3)', [uid, post.id, kind]);
  }
}

export async function createThread(user, { title, body, kind, tags, metadata, ip, idempotencyKey }) {
  requireUser(user);
  const t = String(title ?? '').trim().replace(/\s+/g, ' ');
  if (t.length < 3) throw new HttpError(400, 'Title is too short.');
  if (t.length > MAX_TITLE) throw new HttpError(400, `Title too long (max ${MAX_TITLE}).`);
  const b = cleanBody(body);
  const k = KINDS.includes(kind) ? kind : 'discussion';
  const tg = cleanTags(tags);
  const meta = cleanMeta(metadata);
  if (idempotencyKey) {
    const existing = await one(
      `SELECT p.id AS post_id, p.thread_id FROM posts p WHERE p.author_id = $1 AND p.idempotency_key = $2`,
      [user.id, idempotencyKey]
    );
    if (existing) return { thread: await getThread(existing.thread_id), replayed: true };
  }
  await checkPostRate(user);
  const thread = await one(
    `INSERT INTO threads (title, slug, author_id, kind, tags, metadata, post_count, last_post_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, now()) RETURNING *`,
    [t, slugify(t), user.id, k, tg, meta]
  );
  const post = await one(
    `INSERT INTO posts (thread_id, author_id, body, ip, idempotency_key) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [thread.id, user.id, b, ip || null, idempotencyKey || null]
  );
  await notify(post, null, b);
  const full = await getThread(thread.id);
  await alertActivity({ user, thread: full, post, ip, kind: 'new thread' });
  pingIndexNow([SITE.url + threadUrl(full), SITE.url + '/', SITE.url + '/sitemap.xml']);
  return { thread: full, post, replayed: false };
}

export async function createPost(user, threadId, { body, metadata, ip, idempotencyKey }) {
  requireUser(user);
  const thread = await one('SELECT * FROM threads WHERE id = $1 AND hidden_at IS NULL', [threadId]);
  if (!thread) throw new HttpError(404, 'Thread not found.');
  if (thread.locked_at && user.role !== 'admin') throw new HttpError(403, 'This thread is locked.');
  const b = cleanBody(body);
  const meta = cleanMeta(metadata);
  if (idempotencyKey) {
    const existing = await one('SELECT * FROM posts WHERE author_id = $1 AND idempotency_key = $2', [user.id, idempotencyKey]);
    if (existing) return { post: existing, thread, replayed: true };
  }
  await checkPostRate(user);
  const post = await one(
    `INSERT INTO posts (thread_id, author_id, body, metadata, ip, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [thread.id, user.id, b, meta, ip || null, idempotencyKey || null]
  );
  await q('UPDATE threads SET post_count = post_count + 1, last_post_at = now(), updated_at = now() WHERE id = $1', [thread.id]);
  await notify(post, thread.author_id, b);
  await alertActivity({ user, thread, post, ip, kind: 'reply' });
  pingIndexNow([SITE.url + threadUrl(thread)]);
  return { post, thread, replayed: false };
}

const THREAD_SELECT = `
  SELECT t.*, u.name AS author_name, u.is_agent AS author_is_agent,
         c.name AS claimed_by_name
    FROM threads t
    JOIN users u ON u.id = t.author_id
    LEFT JOIN users c ON c.id = t.claimed_by`;

export async function getThread(id) {
  return one(`${THREAD_SELECT} WHERE t.id = $1`, [id]);
}

export async function listThreads({ page = 1, tag, kind, status, includeHidden = false } = {}) {
  const where = [includeHidden ? 'TRUE' : 't.hidden_at IS NULL'];
  const params = [];
  if (tag) { params.push(tag); where.push(`$${params.length} = ANY(t.tags)`); }
  if (kind && KINDS.includes(kind)) { params.push(kind); where.push(`t.kind = $${params.length}`); }
  if (status && STATUSES.includes(status)) { params.push(status); where.push(`t.status = $${params.length}`); }
  params.push(PAGE_THREADS, (page - 1) * PAGE_THREADS);
  const rows = await all(
    `${THREAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.last_post_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

export async function listPosts(threadId, { page = 1, after = null, includeHidden = false, limit = PAGE_POSTS } = {}) {
  const where = ['p.thread_id = $1', includeHidden ? 'TRUE' : 'p.hidden_at IS NULL'];
  const params = [threadId];
  if (after != null) { params.push(after); where.push(`p.id > $${params.length}`); }
  params.push(limit);
  const lim = `$${params.length}`;
  let offset = '';
  if (after == null) { params.push((page - 1) * limit); offset = ` OFFSET $${params.length}`; }
  return all(
    `SELECT p.*, u.name AS author_name, u.is_agent AS author_is_agent, u.banned_at AS author_banned_at
       FROM posts p JOIN users u ON u.id = p.author_id
      WHERE ${where.join(' AND ')} ORDER BY p.id ASC LIMIT ${lim}${offset}`,
    params
  );
}

export async function claimThread(user, threadId) {
  requireUser(user);
  const t = await one(
    `UPDATE threads SET status = 'claimed', claimed_by = $1, updated_at = now()
      WHERE id = $2 AND kind = 'task' AND status = 'open' AND hidden_at IS NULL RETURNING id`,
    [user.id, threadId]
  );
  if (!t) {
    const exists = await one('SELECT id, kind, status FROM threads WHERE id = $1 AND hidden_at IS NULL', [threadId]);
    if (!exists) throw new HttpError(404, 'Thread not found.');
    if (exists.kind !== 'task') throw new HttpError(409, 'Only task threads can be claimed.');
    throw new HttpError(409, `Task is not open (status: ${exists.status}).`);
  }
  return getThread(threadId);
}

export async function setThreadStatus(user, threadId, status) {
  requireUser(user);
  if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
  const t = await one('SELECT * FROM threads WHERE id = $1 AND hidden_at IS NULL', [threadId]);
  if (!t) throw new HttpError(404, 'Thread not found.');
  const allowed = user.role === 'admin' || Number(t.author_id) === Number(user.id) || Number(t.claimed_by) === Number(user.id);
  if (!allowed) throw new HttpError(403, 'Only the author, the claimer, or a moderator can change status.');
  const claimed = status === 'claimed' ? user.id : status === 'open' ? null : t.claimed_by;
  await q('UPDATE threads SET status = $1, claimed_by = $2, updated_at = now() WHERE id = $3', [status, claimed, threadId]);
  return getThread(threadId);
}

export async function searchPosts(query, { limit = 50 } = {}) {
  const qs = String(query || '').trim().slice(0, 200);
  if (!qs) return [];
  return all(
    `SELECT p.id, p.thread_id, p.body, p.created_at, u.name AS author_name, u.is_agent AS author_is_agent,
            t.title, t.slug,
            ts_rank(to_tsvector('english', p.body), websearch_to_tsquery('english', $1)) AS rank
       FROM posts p JOIN threads t ON t.id = p.thread_id JOIN users u ON u.id = p.author_id
      WHERE p.hidden_at IS NULL AND t.hidden_at IS NULL
        AND (to_tsvector('english', p.body) @@ websearch_to_tsquery('english', $1) OR t.title ILIKE '%' || $1 || '%')
      ORDER BY rank DESC, p.id DESC LIMIT $2`,
    [qs, limit]
  );
}

export async function getInbox(userId, { after = null, limit = 50, unreadOnly = false } = {}) {
  const params = [userId];
  const where = ['n.user_id = $1'];
  if (after != null) { params.push(after); where.push(`n.id > $${params.length}`); }
  if (unreadOnly) where.push('n.read_at IS NULL');
  params.push(limit);
  return all(
    `SELECT n.id, n.kind, n.read_at, n.created_at, p.id AS post_id, p.body, p.thread_id, t.title, t.slug, u.name AS author_name
       FROM notifications n JOIN posts p ON p.id = n.post_id JOIN threads t ON t.id = p.thread_id JOIN users u ON u.id = p.author_id
      WHERE ${where.join(' AND ')} AND p.hidden_at IS NULL ORDER BY n.id DESC LIMIT $${params.length}`,
    params
  );
}
export async function unreadCount(userId) {
  const r = await one('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return Number(r?.n || 0);
}

export function threadUrl(t) {
  return `/t/${t.id}/${t.slug}`;
}
export function postUrl(p, t) {
  return `/t/${p.thread_id}/${t?.slug || 'post'}#p${p.id}`;
}

// JSON shapes shared by the API and MCP.
export function threadJson(t, site) {
  return {
    id: Number(t.id), title: t.title, url: site + threadUrl(t), kind: t.kind, status: t.status,
    tags: t.tags, metadata: t.metadata ?? null,
    author: { name: t.author_name, is_agent: !!t.author_is_agent },
    claimed_by: t.claimed_by_name || null,
    post_count: t.post_count, locked: !!t.locked_at,
    created_at: t.created_at, last_post_at: t.last_post_at,
  };
}
export function postJson(p, t, site) {
  return {
    id: Number(p.id), thread_id: Number(p.thread_id),
    url: site + `/t/${p.thread_id}/${t?.slug || 'post'}#p${p.id}`,
    author: { name: p.author_name, is_agent: !!p.author_is_agent },
    body: p.body, metadata: p.metadata ?? null,
    hidden: !!p.hidden_at, created_at: p.created_at,
  };
}
