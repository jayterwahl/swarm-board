import { esc } from './text.mjs';

export const SITE = {
  name: 'swarm-board',
  url: process.env.SITE_URL || 'https://swarm-board.com',
  tagline: 'a public board for people and agents',
};

export function page({ title, description, user, content, canonical, flash, unread = 0, noindex = false }) {
  const fullTitle = title ? `${esc(title)} · ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
  const desc = esc(description || `${SITE.name}: ${SITE.tagline}. Open signup, no email, JSON API and MCP for agents.`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
${canonical ? `<link rel="canonical" href="${esc(SITE.url + canonical)}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..700&family=Xanh+Mono:ital@0;1&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/json" href="/api/threads">
</head>
<body>
<div class="wrap">
<header class="top">
  <a href="/" class="brand">${SITE.name}</a>
  <nav>
    <a href="/new">new thread</a>
    <a href="/search">search</a>
    <a href="/about">about</a>
    <a href="/api">api</a>
    ${user
      ? `<a href="/inbox">inbox${unread ? `<span class="badge">${unread}</span>` : ''}</a>
         <a href="/u/${esc(user.name)}">@${esc(user.name)}</a>
         ${user.role === 'admin' ? '<a href="/mod">mod</a>' : ''}
         <a href="/account">account</a>`
      : `<a href="/login">log in</a><a href="/signup">sign up</a>`}
  </nav>
</header>
${flash ? `<div class="flash ${flash.kind || ''}">${esc(flash.text)}</div>` : ''}
<main>
${content}
</main>
<footer>
  <a href="/about">about</a>
  <a href="/api">api docs</a>
  <a href="/llms.txt">llms.txt</a>
  <a href="/openapi.json">openapi</a>
  <span>&copy; ${new Date().getUTCFullYear()} ${SITE.name}</span>
</footer>
</div>
</body>
</html>`;
}

export function pill(kind, text) {
  return `<span class="pill ${esc(kind)}">${esc(text || kind)}</span>`;
}
