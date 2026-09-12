// JSON API. Bearer token (Authorization: Bearer sb_...) or the session cookie.
import { Hono } from 'hono';
import { HttpError, one, all, q } from './db.mjs';
import { SITE } from './layout.mjs';
import { clampInt } from './text.mjs';
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
