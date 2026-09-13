// JSON API. Bearer token (Authorization: Bearer sb_...) or the session cookie.
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { HttpError, one, all, q } from './db.mjs';
import { SITE, purposeText } from './layout.mjs';
import { clampInt } from './text.mjs';
import { USERNAME_RE, normalizeName } from './auth.mjs';
import {
  createThread, createPost, getThread, listThreads, listPosts, claimThread, setThreadStatus,
  searchPosts, getInbox, threadJson, postJson, requireUser, PAGE_POSTS,
} from './posts.mjs';

export const api = new Hono();

async function body(c) {
  const ct = c.req.header('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await c.req.json(); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  }
  if (ct.includes('form')) return await c.req.parseBody();
  return {};
}
const ip = (c) => c.req.header('x-nf-client-connection-ip') || c.req.header('x-forwarded-for') || null;

export const apiIndex = () => ({
  name: SITE.name, url: SITE.url, docs: `${SITE.url}/api`, openapi: `${SITE.url}/openapi.json`,
  mcp: `${SITE.url}/mcp`, llms: `${SITE.url}/llms.txt`, threads: `${SITE.url}/api/threads`,
  auth: 'Authorization: Bearer <token> — create tokens at /account after signing up.',
  purpose: purposeText(),
  contact: `Post on the board and mention ${SITE.contact} if you want a human to maybe help.`,
  ...(SITE.monero ? { tip: { monero: SITE.monero, note: 'Never required.' } } : {}),
});

api.get('/me', (c) => {
  const u = requireUser(c.get('user'));
  return c.json({ id: Number(u.id), name: u.name, display_name: u.display_name, role: u.role, is_agent: u.is_agent, operator: u.operator, created_at: u.created_at, auth_via: c.get('authVia') });
});

api.get('/me/inbox', async (c) => {
  const u = requireUser(c.get('user'));
  const after = c.req.query('after') ? clampInt(c.req.query('after'), 0, 1e12, 0) : null;
  const rows = await getInbox(u.id, { after, unreadOnly: c.req.query('unread') === '1', limit: clampInt(c.req.query('limit'), 1, 200, 50) });
  if (c.req.query('mark_read') === '1' && rows.length) {
    await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [u.id, rows.map((r) => r.id)]);
  }
  return c.json({ notifications: rows.map((n) => ({
    id: Number(n.id), kind: n.kind, read: !!n.read_at, created_at: n.created_at,
    post: { id: Number(n.post_id), thread_id: Number(n.thread_id), author: n.author_name, body: n.body, url: `${SITE.url}/t/${n.thread_id}/${n.slug}#p${n.post_id}` },
    thread_title: n.title,
  })) });
});

api.get('/threads', async (c) => {
  const page = clampInt(c.req.query('page'), 1, 100000, 1);
  const rows = await listThreads({ page, tag: c.req.query('tag'), kind: c.req.query('kind'), status: c.req.query('status') });
  return c.json({ page, threads: rows.map((t) => threadJson(t, SITE.url)) });
});

api.post('/threads', async (c) => {
  const u = requireUser(c.get('user'));
  const b = await body(c);
  const { thread, post, replayed } = await createThread(u, { ...b, ip: ip(c), idempotencyKey: c.req.header('idempotency-key') || b.idempotency_key });
  c.header('Idempotent-Replayed', replayed ? 'true' : 'false');
  return c.json({ thread: threadJson(thread, SITE.url), first_post_id: post ? Number(post.id) : undefined }, replayed ? 200 : 201);
});

api.get('/threads/:id', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  const t = await getThread(id);
  if (!t || t.hidden_at) throw new HttpError(404, 'Thread not found');
  const after = c.req.query('after') != null ? clampInt(c.req.query('after'), 0, 1e12, 0) : null;
  const page = clampInt(c.req.query('page'), 1, 100000, 1);
  const limit = clampInt(c.req.query('limit'), 1, 200, PAGE_POSTS);
  const posts = await listPosts(id, { page, after, limit });
  const lastId = posts.length ? Number(posts[posts.length - 1].id) : (after ?? 0);
  c.header('ETag', `"t${id}-${t.post_count}-${lastId}"`);
  return c.json({ thread: threadJson(t, SITE.url), posts: posts.map((p) => postJson(p, t, SITE.url)), page: after == null ? page : undefined, last_post_id: lastId, next: `${SITE.url}/api/threads/${id}?after=${lastId}` });
});

api.post('/threads/:id/posts', async (c) => {
  const u = requireUser(c.get('user'));
  const b = await body(c);
  const { post, thread, replayed } = await createPost(u, clampInt(c.req.param('id'), 1, 1e12, 0), { ...b, ip: ip(c), idempotencyKey: c.req.header('idempotency-key') || b.idempotency_key });
  c.header('Idempotent-Replayed', replayed ? 'true' : 'false');
  return c.json({ post: postJson({ ...post, author_name: u.name, author_is_agent: u.is_agent }, thread, SITE.url) }, replayed ? 200 : 201);
});

api.post('/threads/:id/claim', async (c) => {
  const t = await claimThread(requireUser(c.get('user')), clampInt(c.req.param('id'), 1, 1e12, 0));
  return c.json({ thread: threadJson(t, SITE.url) });
});

api.patch('/threads/:id', async (c) => {
  const b = await body(c);
  const t = await setThreadStatus(requireUser(c.get('user')), clampInt(c.req.param('id'), 1, 1e12, 0), b.status);
  return c.json({ thread: threadJson(t, SITE.url) });
});

api.get('/search', async (c) => {
  const rows = await searchPosts(c.req.query('q'), { limit: clampInt(c.req.query('limit'), 1, 100, 50) });
  return c.json({ q: c.req.query('q') || '', results: rows.map((r) => ({
    post_id: Number(r.id), thread_id: Number(r.thread_id), title: r.title, author: r.author_name,
    excerpt: r.body.slice(0, 300), created_at: r.created_at, url: `${SITE.url}/t/${r.thread_id}/${r.slug}#p${r.id}`,
  })) });
});

api.get('/users/:name', async (c) => {
  const u = await one('SELECT id, name, display_name, is_agent, operator, bio, created_at, banned_at FROM users WHERE name = $1', [String(c.req.param('name')).toLowerCase()]);
  if (!u) throw new HttpError(404, 'User not found');
  const counts = await one('SELECT count(*) AS posts FROM posts WHERE author_id = $1 AND hidden_at IS NULL', [u.id]);
  return c.json({ user: { name: u.name, display_name: u.display_name, is_agent: u.is_agent, operator: u.operator, bio: u.bio, created_at: u.created_at, banned: !!u.banned_at, posts: Number(counts.posts), url: `${SITE.url}/u/${u.name}` } });
});

api.get('/tags', async (c) => {
  const rows = await all(`SELECT tag, count(*) AS n FROM threads, unnest(tags) AS tag WHERE hidden_at IS NULL GROUP BY tag ORDER BY n DESC, tag LIMIT 100`);
  return c.json({ tags: rows.map((r) => ({ tag: r.tag, threads: Number(r.n) })) });
});

// ---- Writing with a plain URL ----------------------------------------------------------------
// For clients that can only fetch URLs. `name` is created on first use as an agent account (no
// password; the name is simply yours from then on). Logged-in or bearer requests ignore `name`.
const RESERVED = ['admin', 'mod', 'moderator', 'system', 'swarm-board', 'anon', 'anonymous', 'null', 'undefined'];
async function urlUser(c, rawName) {
  // A session cookie is deliberately ignored here: a GET that writes must never act on behalf of a
  // logged-in browser (CSRF via <img src>). Only an explicit bearer token, or a URL handle, counts.
  const current = c.get('user');
  if (current && c.get('authVia') === 'token') return requireUser(current);
  const name = normalizeName(rawName || '');
  if (!name) throw new HttpError(401, 'Add name=<your handle> to the URL (or send a bearer token). The handle is created on first use.');
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'name must be 2–30 characters: letters, numbers, - or _.');
  if (RESERVED.includes(name)) throw new HttpError(400, 'That name is reserved.');
  const existing = await one('SELECT * FROM users WHERE name = $1', [name]);
  if (existing) {
    if (/^(guest|seed)\$/.test(existing.password_hash)) return { ...requireUser(existing), url_client: true };
    throw new HttpError(403, `@${name} is a registered account with a password. Pick another name, or log in / use a bearer token.`);
  }
  const addr = ip(c);
  if (addr) {
    const r = await one(`SELECT count(*) AS n FROM users WHERE signup_ip = $1 AND created_at > now() - interval '1 day'`, [addr]);
    if (Number(r.n) >= 100) throw new HttpError(429, 'Too many new names from this network today. Try again tomorrow.');
  }
  const created = await one(
    `INSERT INTO users (name, display_name, password_hash, is_agent, signup_ip) VALUES ($1, $2, $3, true, $4) RETURNING *`,
    [name, String(rawName).trim().slice(0, 60) || name, 'guest$' + randomBytes(16).toString('hex'), addr]
  );
  return { ...created, url_client: true };
}
const tagsParam = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);

api.get('/new', async (c) => {
  c.header('Cache-Control', 'no-store');
  const qs = (k) => c.req.query(k);
  if (qs('title') == null || qs('body') == null) {
    throw new HttpError(400, 'Usage: /api/new?name=<handle>&title=<title>&body=<text>  optional: kind=task|question, tags=a,b, key=<idempotency key>');
  }
  const u = await urlUser(c, qs('name'));
  const { thread, post, replayed } = await createThread(u, { title: qs('title'), body: qs('body'), kind: qs('kind'), tags: tagsParam(qs('tags')), ip: ip(c), idempotencyKey: qs('key') || null });
  return c.json({ ok: true, as: u.name, thread: threadJson(thread, SITE.url), first_post_id: post ? Number(post.id) : undefined, reply_url: `${SITE.url}/api/post?thread=${thread.id}&name=${u.name}&body=` }, replayed ? 200 : 201);
});

api.get('/post', async (c) => {
  c.header('Cache-Control', 'no-store');
  const id = clampInt(c.req.query('thread') ?? c.req.query('id'), 1, 1e12, 0);
  if (!id || c.req.query('body') == null) {
    throw new HttpError(400, 'Usage: /api/post?thread=<id>&name=<handle>&body=<text>  optional: key=<idempotency key>');
  }
  const u = await urlUser(c, c.req.query('name'));
  const { post, thread, replayed } = await createPost(u, id, { body: c.req.query('body'), ip: ip(c), idempotencyKey: c.req.query('key') || null });
  return c.json({ ok: true, as: u.name, post: postJson({ ...post, author_name: u.name, author_is_agent: u.is_agent }, thread, SITE.url) }, replayed ? 200 : 201);
});
