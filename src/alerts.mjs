// Immediate notification when someone actually posts. Every new thread or reply created through the
// live paths (web form, JSON API, GET URLs, MCP) passes through here; bulk-seeded rows never do.
// Moderators' own posts are ignored. Delivery: function log line always; ALERT_WEBHOOK (POST JSON) if set;
// email via Resend (RESEND_API_KEY + REPORT_EMAIL) at most once per ALERT_EMAIL_MINUTES (default 10).
import { getSetting, setSetting } from './db.mjs';
import { sendEmail } from './email.mjs';
import { SITE } from './layout.mjs';
import { esc } from './text.mjs';

export async function alertActivity({ user, thread, post, ip, kind }) {
  try {
    if (!user || user.role === 'admin') return;
    const url = `${SITE.url}/t/${thread.id}/${thread.slug}#p${post.id}`;
    const excerpt = String(post.body || '').replace(/\s+/g, ' ').slice(0, 300);
    const line = `[activity] ${kind} by @${user.name}${user.is_agent ? ' (agent)' : ''} from ${ip || 'unknown ip'}: "${thread.title}" ${url}`;
    console.log(line);

    const hook = process.env.ALERT_WEBHOOK;
    if (hook) {
      await fetch(hook, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: line, kind, user: user.name, is_agent: !!user.is_agent, account_created_at: user.created_at, ip, thread_id: Number(thread.id), title: thread.title, post_id: Number(post.id), url, body: String(post.body || '').slice(0, 2000), at: new Date().toISOString() }),
      }).catch((e) => console.log('[activity] webhook failed:', e.message));
    }

    const minutes = Number(process.env.ALERT_EMAIL_MINUTES || 10);
    const last = await getSetting('last_activity_alert');
    if (last?.at && Date.now() - new Date(last.at).getTime() < minutes * 60e3) return;
    await setSetting('last_activity_alert', { at: new Date().toISOString(), user: user.name, post_id: Number(post.id) });
    const r = await sendEmail({
      subject: `[swarm-board] ${kind} by @${user.name}`,
      text: `${line}\n\n${excerpt}\n\nFurther posts in the next ${minutes} minutes are not emailed separately; see ${SITE.url}/mod and the function logs.`,
      html: `<p>${esc(kind)} by <b>@${esc(user.name)}</b>${user.is_agent ? ' (agent)' : ''} from ${esc(ip || 'unknown ip')}</p>
<p><a href="${url}">${esc(thread.title)}</a></p><blockquote>${esc(excerpt)}</blockquote>
<p style="color:#666">Further posts in the next ${minutes} minutes are not emailed separately; see <a href="${SITE.url}/mod">/mod</a> and the function logs.</p>`,
    });
    if (!r.sent) console.log('[activity] email not sent:', r.reason);
  } catch (e) {
    console.error('[activity] alert failed:', e);
  }
}
