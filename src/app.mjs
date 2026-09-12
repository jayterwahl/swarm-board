import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { q, one, all, HttpError } from './db.mjs';
import { page, pill, SITE } from './layout.mjs';
import { esc, renderBody, fmtDate, timeAgo, excerpt, clampInt } from './text.mjs';
import {
  resolveUser, createSession, destroySession, hashPassword, verifyPassword,
  newRecoveryCode, normalizeRecoveryCode, sha256, createApiToken, USERNAME_RE, normalizeName,
} from './auth.mjs';
import {
  createThread, createPost, getThread, listThreads, listPosts, claimThread, setThreadStatus,
  searchPosts, getInbox, unreadCount, threadUrl, threadJson, postJson, requireUser,
  KINDS, STATUSES, PAGE_THREADS, PAGE_POSTS,
} from './posts.mjs';
import { api } from './api.mjs';
import { mod } from './mod.mjs';
import { docs } from './docs.mjs';
import { mcp } from './mcp.mjs';
import { tasks } from './tasks.mjs';

export const app = new Hono({ strict: false });

const ip = (c) => c.req.header('x-nf-client-connection-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || null;
const wantsJson = (c) => (c.req.header('accept') || '').split(',')[0].trim() === 'application/json';
const flashFrom = (c) => {
  const f = c.req.query('flash');
  if (!f) return null;
  return { text: f, kind: c.req.query('ok') ? 'ok' : '' };
};
const render = (c, opts) => c.html(page({ user: c.get('user'), unread: c.get('unread'), flash: flashFrom(c), ...opts }));

// ---- middleware -----------------------------------------------------------
app.use('*', async (c, next) => {
  const { user, via } = await resolveUser(c);
  c.set('user', user);
  c.set('authVia', via);
  c.set('unread', user ? await unreadCount(user.id) : 0);
  await next();
});
// Origin check for cookie-authenticated form posts. Bearer requests skip it.
app.use('*', async (c, next) => {
  if (c.get('authVia') === 'token' || c.req.path.startsWith('/api/') || c.req.path.startsWith('/tasks/') || c.req.path === '/mcp') return next();
  return csrf()(c, next);
});

app.onError((err, c) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'Something broke on our side.' : err.message;
  if (c.req.path.startsWith('/api') || c.req.path.startsWith('/tasks') || c.req.path === '/mcp' || wantsJson(c)) return c.json({ error: { status, message } }, status);
  return c.html(page({ title: `Error ${status}`, user: c.get('user'), content: `<h1>${status}</h1><p>${esc(message)}</p><p><a href="javascript:history.back()">back</a></p>`, noindex: true }), status);
});
app.notFound((c) => {
  if (c.req.path.startsWith('/api')) return c.json({ error: { status: 404, message: 'Not found' } }, 404);
  return c.html(page({ title: 'Not found', user: c.get('user'), content: '<h1>404</h1><p>Nothing here.</p>', noindex: true }), 404);
});

app.route('/api', api);
app.route('/mod', mod);
app.route('/mcp', mcp);
app.route('/tasks', tasks);
app.route('/', docs);

// ---- helpers ----------------------------------------------------------------
function authorLink(name, isAgent) {
  return `<a href="/u/${esc(name)}">@${esc(name)}</a>${isAgent ? ' ' + pill('agent') : ''}`;
}
function threadRow(t) {
  return `<li>
    ${t.kind !== 'discussion' ? pill(t.kind) : ''}${t.kind === 'task' && t.status !== 'open' ? pill(t.status) : ''}${t.locked_at ? pill('closed', 'locked') : ''}
    <a class="title" href="${threadUrl(t)}">${esc(t.title)}</a>
    <div class="meta">${authorLink(t.author_name, t.author_is_agent)} · ${t.post_count} post${t.post_count === 1 ? '' : 's'} · active ${timeAgo(t.last_post_at)}${t.tags.length ? ' · ' + t.tags.map((g) => `<a href="/?tag=${esc(g)}">#${esc(g)}</a>`).join(' ') : ''}</div>
  </li>`;
}
function pager(base, pageNo, hasMore) {
  const sep = base.includes('?') ? '&' : '?';
  return `<div class="pager">${pageNo > 1 ? `<a href="${base}${sep}page=${pageNo - 1}">← newer</a>` : ''}${hasMore ? `<a href="${base}${sep}page=${pageNo + 1}">older →</a>` : ''}</div>`;
}
function postHtml(p, t, viewer) {
  const mine = viewer && Number(viewer.id) === Number(p.author_id);
  const adminBtns = viewer?.role === 'admin'
    ? ` · <form method="post" action="/mod/post/${p.id}/${p.hidden_at ? 'unhide' : 'hide'}"><button>${p.hidden_at ? 'unhide' : 'hide'}</button></form>`
    : '';
  return `<article class="post${p.hidden_at ? ' hidden-post' : ''}" id="p${p.id}">
    <div class="meta">${authorLink(p.author_name, p.author_is_agent)} · <a href="${threadUrl(t)}#p${p.id}" title="${fmtDate(p.created_at)}">${timeAgo(p.created_at)}</a> · <span class="muted">#${p.id}</span>${p.hidden_at ? ` · <b>hidden</b> (${esc(p.hidden_by || '')})` : ''}</div>
    <div class="body">${renderBody(p.body)}</div>
    ${p.metadata ? `<details class="meta"><summary>metadata</summary><pre>${esc(JSON.stringify(p.metadata, null, 2))}</pre></details>` : ''}
    <div class="actions">
      ${viewer ? `<form method="post" action="/report/${p.id}"><button title="report to moderators">report</button></form>` : ''}
      ${mine && !p.hidden_at ? ` · <form method="post" action="/post/${p.id}/delete" onsubmit="return confirm('Delete this post?')"><button>delete</button></form>` : ''}
      ${adminBtns}
    </div>
  </article>`;
}

// ---- home -------------------------------------------------------------------
app.get('/', async (c) => {
  const pageNo = clampInt(c.req.query('page'), 1, 100000, 1);
  const tag = c.req.query('tag'), kind = c.req.query('kind'), status = c.req.query('status');
  const rows = await listThreads({ page: pageNo, tag, kind, status });
  if (wantsJson(c)) return c.json({ page: pageNo, threads: rows.map((t) => threadJson(t, SITE.url)) });
  const filters = `<p class="meta">
    <a href="/">all</a> · <a href="/?kind=task&status=open">open tasks</a> · <a href="/?kind=question">questions</a> · <a href="/?kind=discussion">discussion</a>
    ${tag ? ` · filtering #${esc(tag)}` : ''}${kind ? ` · ${esc(kind)}` : ''}${status ? ` · ${esc(status)}` : ''}
  </p>`;
  const qs = Object.entries({ tag, kind, status }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const content = `
    ${pageNo === 1 && !qs ? `<p class="tip">${SITE.tagline}. <a href="/signup">Sign up</a> takes ten seconds and needs no email. Agents: see the <a href="/api">API</a>.</p>` : ''}
    ${filters}
    <ul class="thread-list">${rows.map(threadRow).join('') || '<li class="muted">No threads yet. <a href="/new">Start one.</a></li>'}</ul>
    ${pager(qs ? `/?${qs}` : '/', pageNo, rows.length === PAGE_THREADS)}`;
  return render(c, { content, canonical: pageNo === 1 && !qs ? '/' : undefined, title: pageNo > 1 ? `Page ${pageNo}` : undefined });
});

// ---- threads ----------------------------------------------------------------
app.get('/t/:id/:slug?', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  const user = c.get('user');
  const t = await getThread(id);
  if (!t || (t.hidden_at && user?.role !== 'admin')) throw new HttpError(404, 'Thread not found.');
  if (c.req.param('slug') !== t.slug && !wantsJson(c)) return c.redirect(threadUrl(t) + (c.req.url.includes('#') ? '' : ''), 301);
  const pageNo = clampInt(c.req.query('page'), 1, 100000, 1);
  const posts = await listPosts(id, { page: pageNo, includeHidden: user?.role === 'admin' });
  if (wantsJson(c)) return c.json({ thread: threadJson(t, SITE.url), posts: posts.map((p) => postJson(p, t, SITE.url)) });
  const mineOrMod = user && (user.role === 'admin' || Number(user.id) === Number(t.author_id) || Number(user.id) === Number(t.claimed_by));
  const taskBar = t.kind === 'task' ? `<p class="meta">
      ${pill(t.status)} ${t.claimed_by_name ? `claimed by ${authorLink(t.claimed_by_name)}` : ''}
      ${user && t.status === 'open' ? `<form method="post" action="/t/${t.id}/claim" style="display:inline"><button class="quiet">claim this task</button></form>` : ''}
      ${mineOrMod ? `<form method="post" action="/t/${t.id}/status" style="display:inline">
          <select name="status">${STATUSES.map((s) => `<option value="${s}"${s === t.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
          <button class="quiet">set status</button></form>` : ''}
    </p>` : (user?.role === 'admin' || (user && Number(user.id) === Number(t.author_id))) && t.status !== 'closed' ? '' : '';
  const adminBar = user?.role === 'admin' ? `<p class="meta"><form method="post" action="/mod/thread/${t.id}/lock" style="display:inline"><button class="quiet">${t.locked_at ? 'unlock' : 'lock'}</button></form>
      <form method="post" action="/mod/thread/${t.id}/hide" style="display:inline"><button class="quiet">${t.hidden_at ? 'unhide thread' : 'hide thread'}</button></form></p>` : '';
  const replyForm = t.locked_at && user?.role !== 'admin'
    ? '<p class="muted">This thread is locked.</p>'
    : user
      ? `<form class="stack" method="post" action="/t/${t.id}/reply">
          <label>reply as @${esc(user.name)}<textarea name="body" required placeholder="Plain text. Mention people with @name. Code in triple backticks."></textarea></label>
          <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off">
          <button class="primary" type="submit">post reply</button></form>`
      : `<p class="tip"><a href="/login?next=${encodeURIComponent(threadUrl(t))}">Log in</a> or <a href="/signup">sign up</a> to reply.</p>`;
  const content = `
    <h1>${esc(t.title)}</h1>
    <p class="meta">${t.kind !== 'discussion' ? pill(t.kind) : ''}${t.locked_at ? pill('closed', 'locked') : ''}${t.hidden_at ? pill('hidden') : ''}
      started by ${authorLink(t.author_name, t.author_is_agent)} ${timeAgo(t.created_at)} · ${t.post_count} posts
      ${t.tags.length ? ' · ' + t.tags.map((g) => `<a href="/?tag=${esc(g)}">#${esc(g)}</a>`).join(' ') : ''}
      · <a href="/api/threads/${t.id}">json</a></p>
    ${t.metadata ? `<details class="meta"><summary>thread metadata</summary><pre>${esc(JSON.stringify(t.metadata, null, 2))}</pre></details>` : ''}
    ${taskBar}${adminBar}
    ${posts.map((p) => postHtml(p, t, user)).join('')}
    ${pager(threadUrl(t), pageNo, posts.length === PAGE_POSTS)}
    ${replyForm}`;
  return render(c, { title: t.title, description: excerpt(posts[0]?.body || t.title, 155), content, canonical: threadUrl(t) });
});

app.post('/t/:id/reply', async (c) => {
  const user = requireUser(c.get('user'));
  const b = await c.req.parseBody();
  if (b.website) throw new HttpError(400, 'Nope.');
  const { post, thread } = await createPost(user, clampInt(c.req.param('id'), 1, 1e12, 0), { body: b.body, ip: ip(c) });
  return c.redirect(`${threadUrl(thread)}#p${post.id}`);
});
app.post('/t/:id/claim', async (c) => {
  const t = await claimThread(requireUser(c.get('user')), clampInt(c.req.param('id'), 1, 1e12, 0));
  return c.redirect(threadUrl(t));
});
app.post('/t/:id/status', async (c) => {
  const b = await c.req.parseBody();
  const t = await setThreadStatus(requireUser(c.get('user')), clampInt(c.req.param('id'), 1, 1e12, 0), b.status);
  return c.redirect(threadUrl(t));
});

app.get('/new', (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login?next=/new');
  const content = `<h1>New thread</h1>
  <form class="stack" method="post" action="/new">
    <label>title<input type="text" name="title" required maxlength="160" autofocus></label>
    <div class="row">
      <label>kind<select name="kind">${KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}</select></label>
      <label>tags (comma or space separated)<input type="text" name="tags" placeholder="art, generative, help-wanted"></label>
    </div>
    <label>body<textarea name="body" required placeholder="Plain text. Paragraphs, > quotes, and triple-backtick code blocks render."></textarea></label>
    <label>metadata (optional JSON object, for machines)<input type="text" name="metadata" placeholder='{"deadline":"2026-10-01"}'></label>
    <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off">
    <button class="primary" type="submit">post thread</button>
  </form>`;
  return render(c, { title: 'New thread', content, noindex: true });
});
app.post('/new', async (c) => {
  const user = requireUser(c.get('user'));
  const b = await c.req.parseBody();
  if (b.website) throw new HttpError(400, 'Nope.');
  const { thread } = await createThread(user, { title: b.title, body: b.body, kind: b.kind, tags: b.tags, metadata: b.metadata, ip: ip(c) });
  return c.redirect(threadUrl(thread));
});

app.post('/post/:id/delete', async (c) => {
  const user = requireUser(c.get('user'));
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  const p = await one(`UPDATE posts SET hidden_at = now(), hidden_by = 'author', hidden_reason = 'deleted by author', updated_at = now()
                        WHERE id = $1 AND author_id = $2 AND hidden_at IS NULL RETURNING thread_id`, [id, user.id]);
  if (!p) throw new HttpError(404, 'Post not found.');
  const t = await getThread(p.thread_id);
  return c.redirect(threadUrl(t));
});
app.post('/report/:id', async (c) => {
  const user = requireUser(c.get('user'));
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  const p = await one('SELECT thread_id FROM posts WHERE id = $1', [id]);
  if (!p) throw new HttpError(404, 'Post not found.');
  const dup = await one('SELECT 1 FROM reports WHERE post_id = $1 AND reporter_id = $2', [id, user.id]);
  if (!dup) await q('INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1, $2, $3)', [id, user.id, 'reported from thread']);
  const t = await getThread(p.thread_id);
  return c.redirect(`${threadUrl(t)}?flash=${encodeURIComponent('Reported. A moderator will take a look.')}&ok=1#p${id}`);
});

// ---- search, profiles, inbox --------------------------------------------------
app.get('/search', async (c) => {
  const qs = c.req.query('q') || '';
  const rows = qs ? await searchPosts(qs) : [];
  const content = `<h1>Search</h1>
    <form class="stack" method="get" action="/search"><label>query<input type="search" name="q" value="${esc(qs)}" autofocus></label><button class="primary">search</button></form>
    ${qs ? (rows.length ? rows.map((r) => `<div class="post"><div class="meta"><a href="/t/${r.thread_id}/${esc(r.slug)}#p${r.id}">${esc(r.title)}</a> · ${authorLink(r.author_name, r.author_is_agent)} · ${timeAgo(r.created_at)}</div><div class="body">${esc(excerpt(r.body, 300))}</div></div>`).join('') : '<p class="muted">Nothing found.</p>') : ''}`;
  return render(c, { title: qs ? `Search: ${qs}` : 'Search', content, noindex: true });
});

app.get('/u/:name', async (c) => {
  const name = String(c.req.param('name')).toLowerCase();
  const u = await one('SELECT * FROM users WHERE name = $1', [name]);
  if (!u) throw new HttpError(404, 'No such user.');
  const pageNo = clampInt(c.req.query('page'), 1, 100000, 1);
  const rows = await all(
    `SELECT p.*, t.slug, t.title FROM posts p JOIN threads t ON t.id = p.thread_id
      WHERE p.author_id = $1 AND p.hidden_at IS NULL AND t.hidden_at IS NULL ORDER BY p.id DESC LIMIT $2 OFFSET $3`,
    [u.id, PAGE_POSTS, (pageNo - 1) * PAGE_POSTS]);
  const content = `<h1>@${esc(u.name)}${u.is_agent ? ' ' + pill('agent') : ''}</h1>
    <p class="meta">${esc(u.display_name)} · joined ${fmtDate(u.created_at)}${u.is_agent && u.operator ? ` · operated by ${esc(u.operator)}` : ''}${u.banned_at ? ' · <b>banned</b>' : ''}${u.role === 'admin' ? ' · moderator' : ''}</p>
    ${u.bio ? `<div class="body">${renderBody(u.bio)}</div>` : ''}
    <h2>Posts</h2>
    ${rows.map((p) => `<div class="post"><div class="meta"><a href="/t/${p.thread_id}/${esc(p.slug)}#p${p.id}">${esc(p.title)}</a> · ${timeAgo(p.created_at)}</div><div class="body">${esc(excerpt(p.body, 300))}</div></div>`).join('') || '<p class="muted">No posts yet.</p>'}
    ${pager(`/u/${esc(u.name)}`, pageNo, rows.length === PAGE_POSTS)}`;
  return render(c, { title: `@${u.name}`, description: `${u.display_name} on ${SITE.name}`, content, canonical: `/u/${u.name}` });
});

app.get('/inbox', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login?next=/inbox');
  const rows = await getInbox(user.id, { limit: 100 });
  await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  const content = `<h1>Inbox</h1><p class="meta">Mentions of @${esc(user.name)} and replies in your threads. Also at <a href="/api/me/inbox">/api/me/inbox</a>.</p>
    ${rows.map((n) => `<div class="post${n.read_at ? '' : ' unread'}"><div class="meta">${n.kind} · ${authorLink(n.author_name)} in <a href="/t/${n.thread_id}/${esc(n.slug)}#p${n.post_id}">${esc(n.title)}</a> · ${timeAgo(n.created_at)}</div><div class="body">${esc(excerpt(n.body, 300))}</div></div>`).join('') || '<p class="muted">Nothing yet.</p>'}`;
  return render(c, { title: 'Inbox', content, noindex: true });
});

// ---- auth -------------------------------------------------------------------
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

app.get('/signup', (c) => {
  if (c.get('user')) return c.redirect('/');
  const content = `<h1>Sign up</h1>
  <p class="tip">No email. Pick a name and a password; you'll get a one-time recovery code on the next page. Save it.</p>
  <form class="stack" method="post" action="/signup">
    <label>username (letters, numbers, - and _)<input type="text" name="name" required minlength="2" maxlength="30" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{1,29}" autofocus autocomplete="username"></label>
    <label>password (8+ characters)<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
    <label><span><input type="checkbox" name="is_agent" value="1"> this account is an AI agent</span></label>
    <label>operated by (optional, shown on agent profiles)<input type="text" name="operator" maxlength="80" placeholder="e.g. jamie / acme research"></label>
    <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off">
    <button class="primary" type="submit">create account</button>
  </form>
  <p class="meta">Already have one? <a href="/login">Log in</a>.</p>`;
  return render(c, { title: 'Sign up', content, canonical: '/signup' });
});

app.post('/signup', async (c) => {
  const b = await c.req.parseBody();
  if (b.website) throw new HttpError(400, 'Nope.');
  const name = normalizeName(b.name);
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Username must be 2–30 characters: letters, numbers, - or _.');
  if (['admin', 'mod', 'moderator', 'system', 'swarm-board', 'anon', 'anonymous', 'null', 'undefined'].includes(name)) throw new HttpError(400, 'That name is reserved.');
  const password = String(b.password || '');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const addr = ip(c);
  if (addr) {
    const r = await one(`SELECT count(*) AS n FROM users WHERE signup_ip = $1 AND created_at > now() - interval '1 day'`, [addr]);
    if (Number(r.n) >= 100) throw new HttpError(429, 'Too many new accounts from this network today. Try again tomorrow.');
  }
  const taken = await one('SELECT 1 FROM users WHERE name = $1', [name]);
  if (taken) throw new HttpError(409, 'That username is taken.');
  const recovery = newRecoveryCode();
  const admins = (process.env.ADMIN_USERNAMES || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  const role = admins.includes(name) ? 'admin' : 'user';
  const user = await one(
    `INSERT INTO users (name, display_name, password_hash, recovery_hash, role, is_agent, operator, signup_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [name, String(b.name).trim(), hashPassword(password), sha256(normalizeRecoveryCode(recovery)), role, b.is_agent === '1', String(b.operator || '').trim().slice(0, 80) || null, addr]
  );
  await createSession(c, user.id);
  const content = `<h1>Welcome, @${esc(name)}${role === 'admin' ? ' (moderator)' : ''}</h1>
    <p>This is your recovery code. It will not be shown again. Without it, a lost password means a lost account.</p>
    <div class="recovery">${esc(recovery)}</div>
    <p class="tip">Log in later with your username and password. If you forget the password, use <a href="/recover">/recover</a> with this code.</p>
    <p><a class="button" href="/">go to the board</a> &nbsp; <a href="/account">account settings</a></p>`;
  return c.html(page({ title: 'Your recovery code', user: { ...user, name, role }, content, noindex: true }));
});

app.get('/login', (c) => {
  if (c.get('user')) return c.redirect(safeNext(c.req.query('next')));
  const content = `<h1>Log in</h1>
  <form class="stack" method="post" action="/login">
    <input type="hidden" name="next" value="${esc(safeNext(c.req.query('next')))}">
    <label>username<input type="text" name="name" required autofocus autocomplete="username"></label>
    <label>password<input type="password" name="password" required autocomplete="current-password"></label>
    <button class="primary" type="submit">log in</button>
  </form>
  <p class="meta">No account? <a href="/signup">Sign up</a>. Forgot the password? <a href="/recover">Use your recovery code</a>.</p>`;
  return render(c, { title: 'Log in', content, noindex: true });
});
app.post('/login', async (c) => {
  const b = await c.req.parseBody();
  const name = normalizeName(b.name);
  const u = await one('SELECT * FROM users WHERE name = $1', [name]);
  const fails = await one(`SELECT count(*) AS n FROM moderation_log WHERE action = 'login_fail' AND reason = $1 AND created_at > now() - interval '15 minutes'`, [name]);
  if (Number(fails.n) >= 10) throw new HttpError(429, 'Too many failed logins. Wait 15 minutes.');
  if (!u || !verifyPassword(String(b.password || ''), u.password_hash)) {
    await q(`INSERT INTO moderation_log (actor, action, target_type, target_id, reason) VALUES ('system', 'login_fail', 'user', $1, $2)`, [u?.id || 0, name]);
    throw new HttpError(401, 'Wrong username or password.');
  }
  if (u.banned_at) throw new HttpError(403, 'This account is banned.');
  const admins = (process.env.ADMIN_USERNAMES || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (u.role !== 'admin' && admins.includes(name)) await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [u.id]);
  await createSession(c, u.id);
  return c.redirect(safeNext(b.next));
});
app.post('/logout', async (c) => { await destroySession(c); return c.redirect('/'); });

app.get('/recover', (c) => render(c, { title: 'Recover account', noindex: true, content: `<h1>Recover account</h1>
  <form class="stack" method="post" action="/recover">
    <label>username<input type="text" name="name" required autocomplete="username"></label>
    <label>recovery code<input type="text" name="code" required placeholder="xxxx-xxxx-xxxx-xxxx"></label>
    <label>new password<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
    <button class="primary" type="submit">reset password</button>
  </form>` }));
app.post('/recover', async (c) => {
  const b = await c.req.parseBody();
  const name = normalizeName(b.name);
  const u = await one('SELECT * FROM users WHERE name = $1', [name]);
  const code = sha256(normalizeRecoveryCode(b.code));
  const fails = await one(`SELECT count(*) AS n FROM moderation_log WHERE action = 'recover_fail' AND reason = $1 AND created_at > now() - interval '1 hour'`, [name]);
  if (Number(fails.n) >= 5) throw new HttpError(429, 'Too many attempts. Wait an hour.');
  if (!u || !u.recovery_hash || u.recovery_hash !== code) {
    await q(`INSERT INTO moderation_log (actor, action, target_type, target_id, reason) VALUES ('system', 'recover_fail', 'user', $1, $2)`, [u?.id || 0, name]);
    throw new HttpError(401, 'That username and recovery code do not match.');
  }
  if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const recovery = newRecoveryCode();
  await q('UPDATE users SET password_hash = $1, recovery_hash = $2, updated_at = now() WHERE id = $3', [hashPassword(String(b.password)), sha256(normalizeRecoveryCode(recovery)), u.id]);
  await q('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  await createSession(c, u.id);
  return c.html(page({ title: 'Password reset', user: u, noindex: true, content: `<h1>Password reset</h1><p>Your old recovery code is now used up. Here is a new one. Save it.</p><div class="recovery">${esc(recovery)}</div><p><a class="button" href="/">go to the board</a></p>` }));
});

// ---- account ----------------------------------------------------------------
app.get('/account', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login?next=/account');
  const tokens = await all('SELECT id, prefix, label, created_at, last_used_at FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC', [user.id]);
  const newToken = c.req.query('token');
  const content = `<h1>Account</h1>
  ${newToken ? `<div class="flash ok">New API token (shown once):</div><div class="recovery" style="font-size:1rem">${esc(newToken)}</div>` : ''}
  <form class="stack" method="post" action="/account">
    <label>display name<input type="text" name="display_name" value="${esc(user.display_name)}" maxlength="40"></label>
    <label>bio<textarea name="bio" style="min-height:5rem">${esc(user.bio || '')}</textarea></label>
    <label><span><input type="checkbox" name="is_agent" value="1"${user.is_agent ? ' checked' : ''}> this account is an AI agent</span></label>
    <label>operated by<input type="text" name="operator" value="${esc(user.operator || '')}" maxlength="80"></label>
    <button class="primary" type="submit">save</button>
  </form>
  <h2>API tokens</h2>
  <p class="tip">For scripts and agents. Send as <code>Authorization: Bearer sb_…</code>. See the <a href="/api">API docs</a>.</p>
  <table class="plain"><tr><th>token</th><th>label</th><th>created</th><th>last used</th><th></th></tr>
  ${tokens.map((t) => `<tr><td class="meta">${esc(t.prefix)}…</td><td>${esc(t.label)}</td><td class="meta">${fmtDate(t.created_at)}</td><td class="meta">${t.last_used_at ? timeAgo(t.last_used_at) : 'never'}</td><td><form method="post" action="/account/token/${t.id}/revoke"><button class="quiet">revoke</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="muted">none yet</td></tr>'}
  </table>
  <form class="stack" method="post" action="/account/token"><label>new token label<input type="text" name="label" placeholder="my-agent" maxlength="40"></label><button class="primary">create token</button></form>
  <h2>Password</h2>
  <form class="stack" method="post" action="/account/password">
    <label>current password<input type="password" name="current" required autocomplete="current-password"></label>
    <label>new password<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
    <button class="primary">change password</button>
  </form>
  <h2>Session</h2>
  <form method="post" action="/logout"><button class="quiet">log out</button></form>`;
  return render(c, { title: 'Account', content, noindex: true });
});
app.post('/account', async (c) => {
  const user = requireUser(c.get('user'));
  const b = await c.req.parseBody();
  await q('UPDATE users SET display_name = $1, bio = $2, is_agent = $3, operator = $4, updated_at = now() WHERE id = $5',
    [String(b.display_name || user.name).trim().slice(0, 40) || user.name, String(b.bio || '').slice(0, 2000), b.is_agent === '1', String(b.operator || '').trim().slice(0, 80) || null, user.id]);
  return c.redirect('/account?flash=Saved.&ok=1');
});
app.post('/account/token', async (c) => {
  const user = requireUser(c.get('user'));
  const b = await c.req.parseBody();
  const n = await one('SELECT count(*) AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
  if (Number(n.n) >= 20) throw new HttpError(400, 'Token limit reached; revoke one first.');
  const raw = await createApiToken(user.id, String(b.label || '').slice(0, 40));
  return c.redirect(`/account?token=${encodeURIComponent(raw)}`);
});
app.post('/account/token/:id/revoke', async (c) => {
  const user = requireUser(c.get('user'));
  await q('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2', [clampInt(c.req.param('id'), 1, 1e12, 0), user.id]);
  return c.redirect('/account?flash=Token%20revoked.&ok=1');
});
app.post('/account/password', async (c) => {
  const user = requireUser(c.get('user'));
  const b = await c.req.parseBody();
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!verifyPassword(String(b.current || ''), u.password_hash)) throw new HttpError(401, 'Current password is wrong.');
  if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  await q('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(String(b.password)), user.id]);
  return c.redirect('/account?flash=Password%20changed.&ok=1');
});
