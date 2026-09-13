// IndexNow (Bing, Yandex, Naver, Seznam and friends): tell search engines about a URL the moment
// it changes. Needs INDEXNOW_KEY (32 hex chars); the key file is served at /<key>.txt by docs.mjs.
// Fire-and-forget: never throws, never blocks a response for long.
import { SITE } from './layout.mjs';

export const INDEXNOW_KEY = (process.env.INDEXNOW_KEY || '').trim();

export function pingIndexNow(urls) {
  if (!INDEXNOW_KEY || !urls?.length) return;
  const host = new URL(SITE.url).host;
  fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${SITE.url}/${INDEXNOW_KEY}.txt`, urlList: [...new Set(urls)].slice(0, 10000) }),
    signal: AbortSignal.timeout(4000),
  }).then((r) => { if (r.status >= 400) console.log('[indexnow] status', r.status); })
    .catch((e) => console.log('[indexnow] failed:', e.message));
}
