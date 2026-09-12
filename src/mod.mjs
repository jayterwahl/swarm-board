// Moderator pages and actions (role = admin).
import { Hono } from 'hono';
import { q, one, all, HttpError, getSetting } from './db.mjs';
import { page } from './layout.mjs';
import { esc, fmtDate, excerpt, clampInt } from './text.mjs';
import { runBackup } from './backup.mjs';
import { submitSweep, collectSweep, renderReport } from './sweep.mjs';

export const mod = new Hono();

mod.use('*', async (c, next) => {
  const u = c.get('user');
  if (!u) throw new HttpError(401, 'Log in first.');
  if (u.role !== 'admin') throw new HttpError(403, 'Moderators only.');
  await next();
});

async function log(actor, action, targetType, targetId, reason) {
  await q('INSERT INTO moderation_log (actor, action, target_type, target_id, reason) VALUES ($1, $2, $3, $4, $5)', [actor, action, targetType, targetId, reason || null]);
}

const btn = (action, label, extra = '') => `<form method="post" action="${action}" style="display:inline">${extra}<button class="quiet" type="submit">${label}</button></form>`;

mod.get('/', async (c) => {
  const user = c.get('user');
  const flagged = await all(
    `SELECT v.*, p.body, p.hidden_at, p.author_id, u.name AS author, t.id AS thread_id, t.slug, t.title
       FROM ai_verdicts v JOIN posts p ON p.id = v.post_id JOIN users u ON u.id = p.author_id JOIN threads t ON t.id = p.thread_id
      WHERE v.verdict <> 'ok' AND v.reviewed_at IS NULL ORDER BY v.created_at DESC LIMIT 100`
  );
  const reports = await all(
    `SELECT r.*, p.body, p.hidden_at, p.author_id, u.name AS author, t.id AS thread_id, t.slug, t.title, rp.name AS reporter
       FROM reports r JOIN posts p ON p.id = r.post_id JOIN users u ON u.id = p.author_id JOIN threads t ON t.id = p.thread_id
       LEFT JOIN users rp ON rp.id = r.reporter_id
      WHERE r.resolved_at IS NULL ORDER BY r.created_at DESC LIMIT 100`
  );
  const logRows = await all('SELECT * FROM moderation_log ORDER BY id DESC LIMIT 40');
  const reportsList = await all('SELECT report_date, emailed_at, body FROM daily_reports ORDER BY report_date DESC LIMIT 7');
  const backup = await getSetting('last_backup');
  const batches = await all('SELECT * FROM ai_batches ORDER BY created_at DESC LIMIT 5');
  const stats = await one(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM posts) AS posts, (SELECT count(*) FROM threads) AS threads,
                                  (SELECT count(*) FROM users WHERE banned_at IS NOT NULL) AS banned, (SELECT count(*) FROM posts WHERE hidden_at IS NOT NULL) AS hidden`);

  const item = (r, actions) => `<tr>
    <td class="meta">${fmtDate(r.created_at)}</td>
    <td><a href="/t/${r.thread_id}/${esc(r.slug)}#p${r.post_id}">${esc(excerpt(r.title, 50))}</a><br><span class="meta">@${esc(r.author)}${r.hidden_at ? ' · <b>hidden</b>' : ''}</span><br>${esc(excerpt(r.body, 220))}</td>
    <td>${actions}</td></tr>`;

  const content = `
<h1>Moderation</h1>
<div class="grid">
  <div class="stat"><div class="n">${stats.users}</div><div class="l">users (${stats.banned} banned)</div></div>
  <div class="stat"><div class="n">${stats.threads}</div><div class="l">threads</div></div>
  <div class="stat"><div class="n">${stats.posts}</div><div class="l">posts (${stats.hidden} hidden)</div></div>
  <div class="stat"><div class="n">${flagged.length}</div><div class="l">AI-flagged</div></div>
  <div class="stat"><div class="n">${reports.length}</div><div class="l">user reports</div></div>
</div>
<p class="tip">
  ${btn('/mod/run/backup', 'run backup now')} ${btn('/mod/run/backup?full=1', 'full snapshot')}
  ${btn('/mod/run/sweep-submit', 'submit AI sweep')} ${btn('/mod/run/sweep-collect', 'collect sweep + report')}
</p>
<p class="meta">Last backup: ${backup ? (backup.skipped ? `skipped — ${esc(backup.reason)}` : `${esc(backup.at)} · ${backup.files?.length || 0} files · ${backup.bytes || 0} bytes${backup.commit ? ` · commit ${esc(String(backup.commit).slice(0, 7))}` : ''}${backup.snapshot ? ` · <a href="${esc(backup.snapshot.url)}">snapshot</a>` : ''}`) : 'never'}
<br>Sweep: ${process.env.ANTHROPIC_API_KEY ? 'configured' : '<b>ANTHROPIC_API_KEY not set</b>'} · Email: ${process.env.RESEND_API_KEY && process.env.REPORT_EMAIL ? esc(process.env.REPORT_EMAIL) : '<b>not configured</b> (reports still appear below)'} · Backup repo: ${process.env.GITHUB_BACKUP_REPO ? esc(process.env.GITHUB_BACKUP_REPO) : '<b>not configured</b>'}
${batches.length ? `<br>Batches: ${batches.map((b) => `${esc(b.id.slice(-8))} (${b.post_ids.length} posts${b.collected_at ? ', collected' : ', pending'})`).join(' · ')}` : ''}
</p>

<h2>AI-flagged posts (${flagged.length})</h2>
${flagged.length ? `<table class="plain"><tr><th>when</th><th>post</th><th></th></tr>${flagged.map((r) => item(r, `
  <span class="pill ${esc(r.verdict)}">${esc(r.verdict)} ${Number(r.confidence).toFixed(2)}</span><br><span class="meta">${esc(r.reason || '')}</span><br>
  ${r.hidden_at ? btn(`/mod/post/${r.post_id}/unhide`, 'unhide') : btn(`/mod/post/${r.post_id}/hide`, 'hide')}
  ${btn(`/mod/user/${r.author_id}/ban`, 'ban author')}
  ${btn(`/mod/verdict/${r.post_id}/dismiss`, 'dismiss')}`)).join('')}</table>` : '<p class="muted">Queue is empty.</p>'}

<h2>User reports (${reports.length})</h2>
${reports.length ? `<table class="plain"><tr><th>when</th><th>post</th><th></th></tr>${reports.map((r) => item(r, `
  <span class="meta">by @${esc(r.reporter || 'anon')}: ${esc(r.reason || '')}</span><br>
  ${r.hidden_at ? btn(`/mod/post/${r.post_id}/unhide`, 'unhide') : btn(`/mod/post/${r.post_id}/hide`, 'hide')}
  ${btn(`/mod/user/${r.author_id}/ban`, 'ban author')}
  ${btn(`/mod/report/${r.id}/resolve`, 'resolve')}`)).join('')}</table>` : '<p class="muted">No open reports.</p>'}

<h2>Daily reports</h2>
${reportsList.length ? reportsList.map((r) => `<details><summary class="meta">${esc(String(r.report_date).slice(0, 10))} ${r.emailed_at ? '· emailed' : '· not emailed'}</summary><pre class="meta" style="white-space:pre-wrap">${esc(renderReport(r.body).text)}</pre></details>`).join('') : '<p class="muted">None yet. The collect step writes one each morning.</p>'}

<h2>Recent moderation log</h2>
<table class="plain"><tr><th>when</th><th>actor</th><th>action</th><th>target</th><th>reason</th></tr>
${logRows.map((l) => `<tr><td class="meta">${fmtDate(l.created_at)}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td>${esc(l.target_type)} ${l.target_id}</td><td class="meta">${esc(l.reason || '')}</td></tr>`).join('')}
</table>

<h2>Users</h2>
<form method="get" action="/mod/users" class="stack"><label>find user <input type="text" name="q" placeholder="name"></label><button class="primary">search</button></form>
`;
  return c.html(page({ title: 'Moderation', user, content, noindex: true }));
});

mod.get('/users', async (c) => {
  const user = c.get('user');
  const qs = String(c.req.query('q') || '').toLowerCase();
  const rows = await all(
    `SELECT u.*, (SELECT count(*) FROM posts WHERE author_id = u.id) AS posts FROM users u WHERE u.name LIKE '%' || $1 || '%' OR u.signup_ip = $1 ORDER BY u.created_at DESC LIMIT 100`, [qs]);
  const content = `<h1>Users ${qs ? `matching “${esc(qs)}”` : ''}</h1>
<table class="plain"><tr><th>name</th><th>joined</th><th>ip</th><th>posts</th><th>role</th><th></th></tr>
${rows.map((u) => `<tr><td><a href="/u/${esc(u.name)}">@${esc(u.name)}</a>${u.is_agent ? ' <span class="pill agent">agent</span>' : ''}</td><td class="meta">${fmtDate(u.created_at)}</td><td class="meta">${esc(u.signup_ip || '')}</td><td>${u.posts}</td><td>${esc(u.role)}${u.banned_at ? ' <b>banned</b>' : ''}</td>
<td>${u.banned_at ? btn(`/mod/user/${u.id}/unban`, 'unban') : btn(`/mod/user/${u.id}/ban`, 'ban')} ${u.role === 'admin' ? btn(`/mod/user/${u.id}/demote`, 'demote') : btn(`/mod/user/${u.id}/promote`, 'make admin')}</td></tr>`).join('')}
</table>`;
  return c.html(page({ title: 'Users', user, content, noindex: true }));
});

const back = (c) => c.redirect(c.req.header('referer')?.includes('/mod') ? c.req.header('referer') : '/mod');

mod.post('/post/:id/hide', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE posts SET hidden_at = now(), hidden_by = 'mod', hidden_reason = 'moderator', updated_at = now() WHERE id = $1`, [id]);
  await q(`UPDATE ai_verdicts SET reviewed_at = now() WHERE post_id = $1`, [id]);
  await log(c.get('user').name, 'hide_post', 'post', id);
  return back(c);
});
mod.post('/post/:id/unhide', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE posts SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
  await q(`UPDATE ai_verdicts SET reviewed_at = now(), verdict = 'ok' WHERE post_id = $1`, [id]);
  await log(c.get('user').name, 'unhide_post', 'post', id);
  return back(c);
});
mod.post('/verdict/:id/dismiss', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE ai_verdicts SET reviewed_at = now() WHERE post_id = $1`, [id]);
  await log(c.get('user').name, 'dismiss_verdict', 'post', id);
  return back(c);
});
mod.post('/report/:id/resolve', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE reports SET resolved_at = now() WHERE id = $1`, [id]);
  await log(c.get('user').name, 'resolve_report', 'post', id);
  return back(c);
});
mod.post('/user/:id/ban', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  const me = c.get('user');
  if (Number(id) === Number(me.id)) throw new HttpError(400, 'Not yourself.');
  await q(`UPDATE users SET banned_at = now(), ban_reason = 'moderator', updated_at = now() WHERE id = $1 AND role <> 'admin'`, [id]);
  await q(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  await log(me.name, 'ban_user', 'user', id);
  return back(c);
});
mod.post('/user/:id/unban', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE users SET banned_at = NULL, ban_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
  await log(c.get('user').name, 'unban_user', 'user', id);
  return back(c);
});
mod.post('/user/:id/promote', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [id]);
  await log(c.get('user').name, 'promote_user', 'user', id);
  return back(c);
});
mod.post('/user/:id/demote', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  if (Number(id) === Number(c.get('user').id)) throw new HttpError(400, 'Not yourself.');
  await q(`UPDATE users SET role = 'user', updated_at = now() WHERE id = $1`, [id]);
  await log(c.get('user').name, 'demote_user', 'user', id);
  return back(c);
});
mod.post('/thread/:id/lock', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  const t = await one(`UPDATE threads SET locked_at = CASE WHEN locked_at IS NULL THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING locked_at, slug`, [id]);
  await log(c.get('user').name, t?.locked_at ? 'lock_thread' : 'unlock_thread', 'thread', id);
  return c.redirect(`/t/${id}/${t?.slug || ''}`);
});
mod.post('/thread/:id/hide', async (c) => {
  const id = clampInt(c.req.param('id'), 1, 1e12, 0);
  await q(`UPDATE threads SET hidden_at = CASE WHEN hidden_at IS NULL THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [id]);
  await log(c.get('user').name, 'toggle_hide_thread', 'thread', id);
  return c.redirect('/');
});

mod.post('/run/backup', async (c) => {
  const r = await runBackup({ full: c.req.query('full') === '1', reason: `manual by ${c.get('user').name}` });
  return c.html(page({ title: 'Backup result', user: c.get('user'), noindex: true, content: `<h1>Backup</h1><pre class="meta" style="white-space:pre-wrap">${esc(JSON.stringify(r, null, 2))}</pre><p><a href="/mod">back</a></p>` }));
});
mod.post('/run/sweep-submit', async (c) => {
  const r = await submitSweep({ reason: `manual by ${c.get('user').name}` });
  return c.html(page({ title: 'Sweep submitted', user: c.get('user'), noindex: true, content: `<h1>Sweep submit</h1><pre class="meta" style="white-space:pre-wrap">${esc(JSON.stringify(r, null, 2))}</pre><p><a href="/mod">back</a></p>` }));
});
mod.post('/run/sweep-collect', async (c) => {
  const r = await collectSweep({ reason: `manual by ${c.get('user').name}` });
  return c.html(page({ title: 'Sweep collected', user: c.get('user'), noindex: true, content: `<h1>Sweep collect</h1><pre class="meta" style="white-space:pre-wrap">${esc(JSON.stringify(r, null, 2))}</pre><p><a href="/mod">back</a></p>` }));
});
