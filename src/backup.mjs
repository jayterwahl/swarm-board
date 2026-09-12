// Nightly incremental backup to a private GitHub repo, plus monthly full snapshots as release assets.
// Needs GITHUB_TOKEN (fine-grained, Contents: read/write on the backup repo) and GITHUB_BACKUP_REPO ("owner/name").
import { gzipSync } from 'node:zlib';
import { all, getSetting, setSetting } from './db.mjs';

const TABLES = [
  // [table, column used for "changed since" filtering]
  ['users', 'updated_at'],
  ['threads', 'updated_at'],
  ['posts', 'updated_at'],
  ['notifications', 'created_at'],
  ['reports', 'created_at'],
  ['ai_verdicts', 'created_at'],
  ['ai_batches', 'created_at'],
  ['moderation_log', 'created_at'],
  ['daily_reports', 'created_at'],
  ['api_tokens', 'created_at'],
  ['settings', 'updated_at'],
];

function gh(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'swarm-board-backup',
      ...(init.headers || {}),
    },
  });
}

async function putFile(repo, path, contentBuf, message) {
  const existing = await gh(`/repos/${repo}/contents/${path}`);
  const sha = existing.ok ? (await existing.json()).sha : undefined;
  const res = await gh(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: contentBuf.toString('base64'), sha }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.commit?.sha;
}

function ndjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

const README = `# swarm-board backups

Automated by the site's nightly backup function. Do not edit by hand.

- \`daily/YYYY/YYYY-MM-DD/<table>.ndjson.gz\` — rows created or updated since the previous successful backup, one JSON object per line.
- Full snapshots of every table are attached to releases tagged \`snapshot-YYYY-MM-DD\` (monthly, or on demand from /mod).

## Restore

1. Recreate the schema (the migrations in the code repo under \`netlify/database/migrations\`).
2. Load the latest full snapshot: for each \`<table>.ndjson.gz\`, gunzip and insert each line as a row (\`jq -c\` + \`psql \\copy\` or a small script).
3. Replay the daily incrementals dated after the snapshot in order, upserting on primary key.

Password hashes are included so accounts survive a restore. Keep this repo private.
`;

export async function runBackup({ full = false, reason = 'scheduled' } = {}) {
  const repo = process.env.GITHUB_BACKUP_REPO;
  if (!process.env.GITHUB_TOKEN || !repo) {
    const r = { skipped: true, reason: 'GITHUB_TOKEN or GITHUB_BACKUP_REPO not set' };
    await setSetting('last_backup', { at: new Date().toISOString(), ...r });
    return r;
  }
  const startedAt = new Date();
  const since = (await getSetting('last_backup_at')) || '1970-01-01T00:00:00Z';
  const day = startedAt.toISOString().slice(0, 10);
  const files = [];
  let bytes = 0;
  let commit = null;

  const first = await gh(`/repos/${repo}/contents/README.md`);
  if (first.status === 404) commit = await putFile(repo, 'README.md', Buffer.from(README), 'Add restore notes');

  for (const [table, col] of TABLES) {
    const rows = await all(`SELECT * FROM ${table} WHERE ${col} > $1 ORDER BY 1`, [since]);
    if (!rows.length) continue;
    const gz = gzipSync(Buffer.from(ndjson(rows)));
    const path = `daily/${day.slice(0, 4)}/${day}/${table}.ndjson.gz`;
    commit = await putFile(repo, path, gz, `Backup ${day}: ${table} (${rows.length} rows, ${reason})`);
    files.push({ table, rows: rows.length, bytes: gz.length });
    bytes += gz.length;
  }

  let snapshot = null;
  if (full || startedAt.getUTCDate() === 1) snapshot = await fullSnapshot(repo, day);

  await setSetting('last_backup_at', startedAt.toISOString());
  const result = { at: startedAt.toISOString(), since, files, bytes, commit, snapshot, reason };
  await setSetting('last_backup', result);
  return result;
}

async function fullSnapshot(repo, day) {
  const tag = `snapshot-${day}`;
  let rel = await gh(`/repos/${repo}/releases/tags/${tag}`);
  if (rel.status === 404) {
    rel = await gh(`/repos/${repo}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: `Full snapshot ${day}`, body: 'Full table dumps, NDJSON gzipped.' }),
    });
  }
  if (!rel.ok) throw new Error(`GitHub release failed: ${rel.status} ${(await rel.text()).slice(0, 300)}`);
  const release = await rel.json();
  const assets = [];
  for (const [table] of TABLES) {
    const rows = await all(`SELECT * FROM ${table} ORDER BY 1`);
    const gz = gzipSync(Buffer.from(ndjson(rows)));
    const name = `${table}.ndjson.gz`;
    const dup = (release.assets || []).find((a) => a.name === name);
    if (dup) await gh(`/repos/${repo}/releases/assets/${dup.id}`, { method: 'DELETE' });
    const up = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/gzip',
        'User-Agent': 'swarm-board-backup', 'X-GitHub-Api-Version': '2022-11-28',
      },
      body: gz,
    });
    if (!up.ok) throw new Error(`Asset upload ${name} failed: ${up.status}`);
    assets.push({ table, rows: rows.length, bytes: gz.length });
  }
  return { tag, url: release.html_url, assets };
}
