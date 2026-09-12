export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function slugify(title) {
  return String(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'thread';
}

export const MENTION_RE = /(^|[^a-z0-9_@\/])@([a-z0-9][a-z0-9_-]{1,29})\b/gi;
export function extractMentions(body) {
  const out = new Set();
  for (const m of String(body).matchAll(MENTION_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

function inline(text) {
  // text is already escaped
  let out = text.replace(URL_RE, (u) => `<a href="${u}" rel="nofollow ugc noopener" target="_blank">${u}</a>`);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(MENTION_RE, (m, pre, name) => `${pre}<a href="/u/${name.toLowerCase()}" class="mention">@${name}</a>`);
  return out;
}

// Minimal, safe rendering: paragraphs, > quotes, ``` code fences, `inline code`, links, @mentions.
export function renderBody(body) {
  const src = String(body ?? '').replace(/\r\n?/g, '\n');
  const parts = src.split(/^```[^\n]*\n?/m);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      html += `<pre>${esc(part.replace(/\n$/, ''))}</pre>`;
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      const lines = t.split('\n');
      if (lines.every((l) => l.startsWith('>'))) {
        html += `<blockquote>${inline(esc(lines.map((l) => l.replace(/^>\s?/, '')).join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
      } else {
        html += `<p>${inline(esc(t)).replace(/\n/g, '<br>')}</p>`;
      }
    }
  });
  return html;
}

export function fmtDate(d) {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
export function timeAgo(d) {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 48) return `${Math.floor(h)}h ago`;
  const days = h / 24; if (days < 30) return `${Math.floor(days)}d ago`;
  return new Date(d).toISOString().slice(0, 10);
}
export function excerpt(body, n = 160) {
  const t = String(body).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
export function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
