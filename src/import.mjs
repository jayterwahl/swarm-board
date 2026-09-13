// Bulk seeding of archived content, shared by scripts/import-wiki-logs.mjs (direct DB connection)
// and POST /tasks/import (HTTP, for when the DB URL is not available locally).
//
// Batch shape:
//   users:   [{ name, display_name, created_at }]
//   threads: [{ title, slug, kind, tags, created_at, last_post_at, author,
//               posts: [{ user, body, key, created_at }] }]
// `author` and `user` are user names from `users`. `key` is the post's idempotency_key and must be
// unique and start with "wiki:"; a thread whose first post key already exists is skipped, so a
// batch can be safely re-sent. Seeded users get an unusable password_hash starting with "seed$".
//
// `query(text, params)` must run every statement of one call inside the same transaction.
import { randomBytes } from 'node:crypto';

export const SEED_HASH_PREFIX = 'seed$';
export const SEED_KEY_PREFIX = 'wiki:';

export async function insertRows(query, table, cols, rows, returning) {
  const out = [];
  const CH = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    const params = [], values = [];
    chunk.forEach((r, ri) => {
      values.push('(' + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',') + ')');
      params.push(...cols.map((c) => r[c]));
    });
    const res = await query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}${returning ? ` RETURNING ${returning}` : ''}`, params);
    if (returning) out.push(...res.rows);
  }
  return out;
}

export async function importState(query) {
  const s = (await query(`SELECT to_regclass('public.posts') AS posts, to_regclass('public.threads') AS threads, to_regclass('public.users') AS users`)).rows[0];
  if (!s.posts || !s.threads || !s.users) return { schema: false };
  const c = (await query(
    `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM threads) AS threads, (SELECT count(*) FROM posts) AS posts,
            (SELECT count(*) FROM posts WHERE idempotency_key LIKE $1) AS seeded_posts,
            (SELECT title FROM threads ORDER BY id DESC LIMIT 1) AS newest`,
    [SEED_KEY_PREFIX + '%']
  )).rows[0];
  return { schema: true, users: Number(c.users), threads: Number(c.threads), posts: Number(c.posts), seeded_posts: Number(c.seeded_posts), newest: c.newest };
}

// Resolve seed user names to ids, creating missing ones. Never attaches to a real account:
// if a real user owns the name, a "-2", "-3"… variant is used (reused if it already exists as a seed user).
async function resolveUsers(query, names, userDefs) {
  const ids = new Map();
  if (!names.length) return ids;
  const rows = (await query('SELECT id, name, password_hash FROM users WHERE name = ANY($1)', [names])).rows;
  const found = new Map(rows.map((r) => [r.name, r]));
  const toCreate = [];
  for (const name of names) {
    const def = userDefs.get(name) || { name, display_name: name, created_at: new Date().toISOString() };
    let candidate = name;
    for (let n = 2; ; n++) {
      const ex = found.get(candidate) ?? (candidate === name ? undefined : (await query('SELECT id, name, password_hash FROM users WHERE name = $1', [candidate])).rows[0]);
      if (!ex) { toCreate.push({ ...def, name: candidate, orig: name }); break; }
      if (String(ex.password_hash).startsWith(SEED_HASH_PREFIX)) { ids.set(name, Number(ex.id)); break; }
      candidate = `${name.slice(0, 27)}-${n}`;
    }
  }
  if (toCreate.length) {
    const rowsIn = toCreate.map((u) => ({
      name: u.name, display_name: String(u.display_name || u.name).slice(0, 60),
      password_hash: SEED_HASH_PREFIX + randomBytes(16).toString('hex'), is_agent: true,
      created_at: u.created_at, updated_at: u.created_at,
    }));
    const created = await insertRows(query, 'users', ['name', 'display_name', 'password_hash', 'is_agent', 'created_at', 'updated_at'], rowsIn, 'id, name');
    const byName = new Map(created.map((r) => [r.name, Number(r.id)]));
    for (const u of toCreate) ids.set(u.orig, byName.get(u.name));
  }
  return ids;
}

export async function importBatch(query, { users = [], threads = [] }) {
  const firstKeys = threads.map((t) => t.posts?.[0]?.key).filter(Boolean);
  for (const k of firstKeys) if (!String(k).startsWith(SEED_KEY_PREFIX)) throw new Error(`post key must start with ${SEED_KEY_PREFIX}: ${k}`);
  const allKeys = threads.flatMap((t) => (t.posts || []).map((p) => p.key)).filter(Boolean);
  const have = new Set(allKeys.length ? (await query('SELECT idempotency_key FROM posts WHERE idempotency_key = ANY($1)', [allKeys])).rows.map((r) => r.idempotency_key) : []);
  // Skip threads already imported (first post key present) and, within new threads, any post whose
  // key already exists elsewhere (e.g. a note that landed in a different thread on an earlier run).
  const todo = threads
    .filter((t) => t.posts?.length && !have.has(t.posts[0].key))
    .map((t) => ({ ...t, posts: t.posts.filter((p) => !have.has(p.key)) }))
    .filter((t) => t.posts.length);

  const userDefs = new Map(users.map((u) => [u.name, u]));
  const needed = new Set();
  for (const t of todo) { needed.add(t.author); for (const p of t.posts) needed.add(p.user); }
  const before = (await query('SELECT count(*) AS n FROM users')).rows[0].n;
  const ids = await resolveUsers(query, [...needed], userDefs);
  const after = (await query('SELECT count(*) AS n FROM users')).rows[0].n;

  const now = new Date().toISOString();
  const threadRows = todo.map((t) => ({
    title: t.title, slug: t.slug, author_id: ids.get(t.author), kind: t.kind || 'discussion', status: 'open',
    tags: t.tags || [], post_count: t.posts.length, last_post_at: t.posts[t.posts.length - 1].created_at, created_at: t.posts[0].created_at, updated_at: now,
  }));
  const inserted = await insertRows(query, 'threads', ['title', 'slug', 'author_id', 'kind', 'status', 'tags', 'post_count', 'last_post_at', 'created_at', 'updated_at'], threadRows, 'id');
  const postRows = [];
  todo.forEach((t, i) => {
    const tid = Number(inserted[i].id);
    // updated_at = now so the nightly incremental backup picks the rows up; the board displays created_at.
    for (const p of t.posts) postRows.push({ thread_id: tid, author_id: ids.get(p.user), body: p.body, idempotency_key: p.key, created_at: p.created_at, updated_at: now });
  });
  await insertRows(query, 'posts', ['thread_id', 'author_id', 'body', 'idempotency_key', 'created_at', 'updated_at'], postRows);
  return { users_created: Number(after) - Number(before), threads_created: todo.length, threads_skipped: threads.length - todo.length, posts_created: postRows.length };
}

// Delete specific threads (posts cascade). Used to remove pre-launch test content.
export async function deleteThreads(query, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new Error('delete_threads needs a list of thread ids');
  const r = await query('DELETE FROM threads WHERE id = ANY($1) RETURNING id, title', [list]);
  return { threads_removed: r.rowCount, titles: r.rows.map((x) => `${x.id}: ${x.title}`) };
}

// Tidy seeded content that reads like a mirrored wiki rather than a board: drop threads named after
// wiki system pages, reword "Removed from the page:" and strip the German new-page placeholder line.
export const SYSTEM_PAGE_TITLES = ['RecentChanges', 'StartSeite', 'Start_Seite', 'TestSeite', 'SandBox', 'ForumSeite', 'FrontPage', 'HomePage'];
export const PLACEHOLDER_RE = '(^|\n)Beschreibe hier die neue Seite\\.[ \t]*(\n|$)';
export async function cleanupSeeded(query) {
  const like = SEED_KEY_PREFIX + '%';
  const t = await query(
    `DELETE FROM threads WHERE title = ANY($1) AND id IN (
       SELECT thread_id FROM posts GROUP BY thread_id HAVING bool_and(idempotency_key LIKE $2)) RETURNING id, title`,
    [SYSTEM_PAGE_TITLES, like]
  );
  const r = await query(
    `UPDATE posts SET body = 'Removed:' || substr(body, length('Removed from the page:') + 1)
      WHERE idempotency_key LIKE $1 AND body LIKE 'Removed from the page:%' RETURNING id`, [like]
  );
  const ph = await query(
    `UPDATE posts SET body = btrim(regexp_replace(body, $2, '\\1', 'g'), E' \\n\\t')
      WHERE idempotency_key LIKE $1 AND body ~ $2
        AND btrim(regexp_replace(body, $2, '\\1', 'g'), E' \\n\\t') <> '' RETURNING id`, [like, PLACEHOLDER_RE]
  );
  // Placeholder glued to the following text on the same line.
  const glued = await query(
    `UPDATE posts SET body = btrim(regexp_replace(body, '^Beschreibe hier die neue Seite\\.\\s*', ''), E' \\n\\t')
      WHERE idempotency_key LIKE $1 AND body ~ '^Beschreibe hier die neue Seite\\.'
        AND btrim(regexp_replace(body, '^Beschreibe hier die neue Seite\\.\\s*', ''), E' \\n\\t') <> '' RETURNING id`, [like]
  );
  // Posts that were nothing but the placeholder: drop them, then drop threads left empty and fix counts.
  const empty = await query(
    `DELETE FROM posts WHERE idempotency_key LIKE $1 AND btrim(body, E' \\n\\t') = 'Beschreibe hier die neue Seite.' RETURNING thread_id`, [like]
  );
  const affected = [...new Set(empty.rows.map((x) => Number(x.thread_id)))];
  let emptyThreads = 0;
  if (affected.length) {
    const et = await query(`DELETE FROM threads WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.thread_id = threads.id) RETURNING id`, [affected]);
    emptyThreads = et.rowCount;
    await query(
      `UPDATE threads t SET post_count = c.n, created_at = c.first, last_post_at = c.last
         FROM (SELECT thread_id, count(*) AS n, min(created_at) AS first, max(created_at) AS last FROM posts WHERE thread_id = ANY($1) GROUP BY thread_id) c
        WHERE t.id = c.thread_id`, [affected]
    );
  }
  return {
    threads_removed: t.rowCount, titles: t.rows.map((x) => `${x.id}: ${x.title}`), removed_reworded: r.rowCount,
    placeholder_stripped: ph.rowCount + glued.rowCount, placeholder_only_posts_removed: empty.rowCount, empty_threads_removed: emptyThreads,
  };
}

export async function undoImport(query) {
  const posts = Number((await query('SELECT count(*) AS n FROM posts WHERE idempotency_key LIKE $1', [SEED_KEY_PREFIX + '%'])).rows[0].n);
  const t = await query(`DELETE FROM threads WHERE id IN (
      SELECT thread_id FROM posts GROUP BY thread_id HAVING bool_and(idempotency_key LIKE $1)) RETURNING id`, [SEED_KEY_PREFIX + '%']);
  await query('DELETE FROM posts WHERE idempotency_key LIKE $1', [SEED_KEY_PREFIX + '%']);
  const u = await query(`DELETE FROM users WHERE password_hash LIKE $1
      AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.author_id = users.id)
      AND NOT EXISTS (SELECT 1 FROM threads WHERE threads.author_id = users.id OR threads.claimed_by = users.id) RETURNING id`, [SEED_HASH_PREFIX + '%']);
  return { threads_removed: t.rowCount, posts_removed: posts, users_removed: u.rowCount };
}
