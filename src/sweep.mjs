// Daily AI moderation sweep, in two halves because a function can't wait for a batch:
//   submitSweep()  — gathers the last day's posts, submits one Message Batch (50% price)
//   collectSweep() — fetches finished batches, applies verdicts, writes the daily report, emails it
import Anthropic from '@anthropic-ai/sdk';
import { q, one, all, getSetting } from './db.mjs';
import { sendEmail } from './email.mjs';
import { SITE } from './layout.mjs';
import { esc } from './text.mjs';

const MODEL = process.env.SWEEP_MODEL || 'claude-opus-5';
const CHUNK = 50;
const AUTO_HIDE_CONFIDENCE = 0.8;

const SYSTEM = `You are the moderation reviewer for swarm-board, a small public message board where humans and AI agents talk and coordinate on tasks. Open signup, no email verification, so spam and abuse arrive through new accounts.

Classify each post:
- "spam": unsolicited advertising, SEO link dumps, crypto/pill/casino promotion, scams, repeated boilerplate, off-topic commercial content, obvious bot noise.
- "abuse": harassment, threats, doxxing, slurs, sexual content involving minors, or content meant to harm a specific person.
- "review": you are unsure, or it is borderline (aggressive but arguably on-topic, self-promotion by a participating member, possible but not certain spam). A human moderator will look.
- "ok": everything else. Disagreement, strong opinions, weird art talk, agents coordinating on tasks, and terse machine-style posts are all fine.

Account age and posting pattern matter: a brand-new account posting links is more suspicious than a regular. Do not flag posts merely for being written by an agent. Give a one-line reason for anything that is not "ok".`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          post_id: { type: 'integer' },
          verdict: { type: 'string', enum: ['ok', 'review', 'spam', 'abuse'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['post_id', 'verdict', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic();
}

export async function submitSweep({ reason = 'scheduled' } = {}) {
  const anthropic = client();
  if (!anthropic) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' };
  const posts = await all(
    `SELECT p.id, p.body, p.created_at, u.name AS author, u.is_agent, u.created_at AS account_created,
            t.title, (SELECT count(*) FROM posts x WHERE x.author_id = p.author_id) AS author_post_count
       FROM posts p JOIN users u ON u.id = p.author_id JOIN threads t ON t.id = p.thread_id
      WHERE p.created_at > now() - interval '26 hours' AND p.hidden_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ai_verdicts v WHERE v.post_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM ai_batches b WHERE b.collected_at IS NULL AND p.id = ANY(b.post_ids))
      ORDER BY p.id LIMIT 5000`
  );
  if (!posts.length) return { submitted: 0, reason: 'nothing new' };

  const requests = [];
  for (let i = 0; i < posts.length; i += CHUNK) {
    const chunk = posts.slice(i, i + CHUNK).map((p) => ({
      post_id: Number(p.id),
      author: p.author,
      author_is_agent: !!p.is_agent,
      account_age_hours: Math.round((new Date(p.created_at) - new Date(p.account_created)) / 36e5),
      author_total_posts: Number(p.author_post_count),
      thread_title: p.title,
      body: p.body.slice(0, 2000),
    }));
    requests.push({
      custom_id: `chunk-${i / CHUNK}`,
      params: {
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Classify these ${chunk.length} posts. Return one verdict per post_id.\n\n${JSON.stringify(chunk)}` }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      },
    });
  }
  const batch = await anthropic.messages.batches.create({ requests });
  await q('INSERT INTO ai_batches (id, post_ids) VALUES ($1, $2)', [batch.id, posts.map((p) => Number(p.id))]);
  return { submitted: posts.length, requests: requests.length, batch_id: batch.id, reason };
}

async function logMod(actor, action, targetType, targetId, reason) {
  await q('INSERT INTO moderation_log (actor, action, target_type, target_id, reason) VALUES ($1, $2, $3, $4, $5)', [actor, action, targetType, targetId, reason]);
}

export async function collectSweep({ reason = 'scheduled' } = {}) {
  const anthropic = client();
  const pending = await all('SELECT * FROM ai_batches WHERE collected_at IS NULL ORDER BY created_at');
  const outcome = { batches: [], hidden: 0, banned: 0, review: 0, ok: 0, errors: 0, still_running: 0 };

  for (const b of pending) {
    if (!anthropic) break;
    const info = await anthropic.messages.batches.retrieve(b.id);
    if (info.processing_status !== 'ended') { outcome.still_running++; continue; }
    const counts = { hidden: 0, banned: 0, review: 0, ok: 0, errors: 0 };
    for await (const result of await anthropic.messages.batches.results(b.id)) {
      if (result.result.type !== 'succeeded') { counts.errors++; continue; }
      const msg = result.result.message;
      if (msg.stop_reason === 'refusal') { counts.errors++; continue; }
      const text = msg.content.find((c) => c.type === 'text')?.text || '{}';
      let parsed;
      try { parsed = JSON.parse(text); } catch { counts.errors++; continue; }
      for (const v of parsed.verdicts || []) {
        if (!b.post_ids.map(Number).includes(Number(v.post_id))) continue;
        await q(
          `INSERT INTO ai_verdicts (post_id, batch_id, verdict, confidence, reason) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (post_id) DO UPDATE SET verdict = EXCLUDED.verdict, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason, batch_id = EXCLUDED.batch_id`,
          [v.post_id, b.id, v.verdict, v.confidence, v.reason]
        );
        if ((v.verdict === 'spam' || v.verdict === 'abuse') && v.confidence >= AUTO_HIDE_CONFIDENCE) {
          const hid = await one(
            `UPDATE posts SET hidden_at = now(), hidden_by = 'ai', hidden_reason = $2, updated_at = now()
              WHERE id = $1 AND hidden_at IS NULL RETURNING author_id`,
            [v.post_id, `${v.verdict}: ${v.reason}`.slice(0, 500)]
          );
          if (hid) {
            counts.hidden++;
            await logMod('ai', 'hide_post', 'post', v.post_id, `${v.verdict} (${v.confidence}): ${v.reason}`);
            const strikes = await one(
              `SELECT count(*) AS n, (SELECT created_at FROM users WHERE id = $1) AS joined
                 FROM posts WHERE author_id = $1 AND hidden_by = 'ai'`,
              [hid.author_id]
            );
            const young = Date.now() - new Date(strikes.joined).getTime() < 7 * 86400e3;
            if (Number(strikes.n) >= (young ? 2 : 4)) {
              const banned = await one(
                `UPDATE users SET banned_at = now(), ban_reason = $2, updated_at = now() WHERE id = $1 AND banned_at IS NULL AND role <> 'admin' RETURNING id`,
                [hid.author_id, `automatic: ${strikes.n} posts hidden by AI sweep`]
              );
              if (banned) { counts.banned++; await logMod('ai', 'ban_user', 'user', hid.author_id, `${strikes.n} posts hidden by sweep`); }
            }
          }
        } else if (v.verdict === 'review' || v.verdict === 'spam' || v.verdict === 'abuse') {
          counts.review++;
        } else {
          counts.ok++;
        }
      }
    }
    await q('UPDATE ai_batches SET collected_at = now(), summary = $2 WHERE id = $1', [b.id, JSON.stringify(counts)]);
    outcome.batches.push({ id: b.id, ...counts });
    for (const k of ['hidden', 'banned', 'review', 'ok', 'errors']) outcome[k] += counts[k];
  }

  const report = await buildDailyReport({ sweep: outcome, anthropicConfigured: !!anthropic });
  return { ...outcome, report: report.date, emailed: report.emailed, reason };
}

export async function buildDailyReport({ sweep, anthropicConfigured }) {
  const date = new Date().toISOString().slice(0, 10);
  const stats = await one(
    `SELECT (SELECT count(*) FROM posts WHERE created_at > now() - interval '1 day') AS posts_24h,
            (SELECT count(*) FROM threads WHERE created_at > now() - interval '1 day') AS threads_24h,
            (SELECT count(*) FROM users WHERE created_at > now() - interval '1 day') AS users_24h,
            (SELECT count(*) FROM users) AS users_total,
            (SELECT count(*) FROM posts) AS posts_total,
            (SELECT count(*) FROM ai_verdicts WHERE verdict IN ('review','spam','abuse') AND reviewed_at IS NULL
               AND post_id IN (SELECT id FROM posts WHERE hidden_at IS NULL)) AS review_queue,
            (SELECT count(*) FROM reports WHERE resolved_at IS NULL) AS open_reports`
  );
  const flagged = await all(
    `SELECT v.post_id, v.verdict, v.confidence, v.reason, t.id AS thread_id, t.slug, t.title, u.name AS author, p.hidden_at
       FROM ai_verdicts v JOIN posts p ON p.id = v.post_id JOIN threads t ON t.id = p.thread_id JOIN users u ON u.id = p.author_id
      WHERE v.created_at > now() - interval '1 day' AND v.verdict <> 'ok' ORDER BY v.confidence DESC LIMIT 15`
  );
  const backup = await getSetting('last_backup');
  const body = {
    date, sweep, anthropicConfigured, backup,
    stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v)])),
    flagged: flagged.map((f) => ({ ...f, post_id: Number(f.post_id), thread_id: Number(f.thread_id) })),
  };
  await q(
    `INSERT INTO daily_reports (report_date, body) VALUES ($1, $2)
     ON CONFLICT (report_date) DO UPDATE SET body = EXCLUDED.body`,
    [date, JSON.stringify(body)]
  );
  const email = await sendEmail({ subject: `swarm-board daily: ${body.stats.posts_24h} posts, ${sweep.hidden} hidden, ${body.stats.review_queue} to review`, ...renderReport(body) });
  if (email.sent) await q('UPDATE daily_reports SET emailed_at = now() WHERE report_date = $1', [date]);
  return { date, emailed: email };
}

export function renderReport(r) {
  const s = r.stats;
  const lines = [
    `swarm-board daily report — ${r.date}`,
    ``,
    `Last 24h: ${s.posts_24h} posts, ${s.threads_24h} threads, ${s.users_24h} new accounts (totals: ${s.users_total} users, ${s.posts_total} posts)`,
    `AI sweep: ${r.anthropicConfigured ? `${r.sweep.hidden} hidden, ${r.sweep.banned} banned, ${r.sweep.review} queued, ${r.sweep.ok} ok, ${r.sweep.errors} errors, ${r.sweep.still_running} batches still running` : 'not configured (ANTHROPIC_API_KEY missing)'}`,
    `Moderation queue: ${s.review_queue} AI-flagged, ${s.open_reports} user reports → ${SITE.url}/mod`,
    `Backup: ${r.backup ? (r.backup.skipped ? `skipped (${r.backup.reason})` : `${r.backup.at} · ${r.backup.files?.length || 0} files · ${r.backup.bytes || 0} bytes · commit ${(r.backup.commit || '').slice(0, 7)}${r.backup.snapshot ? ` · snapshot ${r.backup.snapshot.tag}` : ''}`) : 'never run'}`,
  ];
  if (r.flagged.length) {
    lines.push('', 'Flagged:');
    for (const f of r.flagged) lines.push(`  [${f.verdict} ${Number(f.confidence).toFixed(2)}${f.hidden_at ? ' hidden' : ''}] @${f.author} in "${f.title}" — ${f.reason}  ${SITE.url}/t/${f.thread_id}/${f.slug}#p${f.post_id}`);
  }
  const text = lines.join('\n');
  const html = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap">${esc(text)}</pre>`;
  return { text, html };
}
