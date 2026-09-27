// sw.js
// Service worker: keeps a copy of the app's own files (index.html, the
// CSS/JS, the manifest and icons) in the browser's cache, so the app
// starts and works without internet - e.g. at the table with no wifi.
// Your notes themselves live in localStorage (see store.js), not here.
//
// - Opening the app: index.html is fetched from the network if that
//   answers within a few seconds (so updates arrive as usual), otherwise
//   the cached copy is used. Every time a fresh index.html arrives, the
//   files it links to (with their ?v=N, see README.md) and the icons listed
//   in the manifest are cached too, and old versions are dropped - so the
//   app is ready to go offline right after an online visit, and bumping
//   ?v=N is still all an update needs.
// - That update is all-or-nothing: the new index.html only replaces the
//   saved one once every file it needs has been saved. If any download
//   fails (bad wifi, app closed halfway), the old, complete copy stays and
//   it's tried again on the next visit - so the offline copy can never end
//   up pointing at a file it doesn't have.
// - Every other file of the app: from the cache when there, otherwise
//   from the network (and then cached). Versioned URLs (?v=N) never go
//   stale, so there's nothing to re-check.
// - Anything on another origin (Google's sign-in library, the Drive API)
//   is left alone: Drive sync needs internet anyway.
//
// Only runs over https:// or http://localhost - not from file://.

const CACHE = 'rpg-notes-app';
const INDEX_URL = new URL('./', self.location).href;
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  event.waitUntil(fetchIndex().then(cacheApp).catch(() => { /* offline right now - cached on the next visit */ }));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // only the app itself - any other page in the folder goes to the network as usual
    if (url.pathname === new URL(INDEX_URL).pathname || url.pathname.endsWith('/index.html')) {
      event.respondWith(openApp(event));
    }
  } else {
    event.respondWith(fromCacheOrNetwork(req));
  }
});

function fetchIndex() {
  return fetch(INDEX_URL, { cache: 'no-cache' }).then(res => {
    if (!res.ok) throw new Error('index.html: HTTP ' + res.status);
    return res;
  });
}

// index.html from the network if it answers in time, else the cached copy.
// A network answer that arrives late still refreshes the cache.
async function openApp(event) {
  const fromNetwork = fetchIndex();
  event.waitUntil(fromNetwork.then(res => cacheApp(res.clone())).catch(() => {}));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS));
  try {
    return (await Promise.race([fromNetwork, timeout])).clone();
  } catch (err) {
    const cached = await caches.match(INDEX_URL);
    if (cached) return cached;
    return fromNetwork; // nothing cached yet: wait for the network after all
  }
}

async function fromCacheOrNetwork(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(req, res.clone());
  }
  return res;
}

// saves every local file index.html links to, plus the icons listed in
// the manifest; then (only if all of that worked) index.html itself, and
// drops cached files it no longer links to (older ?v=N versions). Throws,
// changing nothing that's in use, if any file couldn't be saved.
async function cacheApp(indexResponse) {
  const html = await indexResponse.clone().text();
  const cache = await caches.open(CACHE);

  const urls = new Set();
  for (const [, url] of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    const absolute = new URL(url, INDEX_URL);
    if (absolute.origin === self.location.origin) urls.add(absolute.href);
  }
  await Promise.all([...urls].map(url => saveFile(cache, url)));

  // the icons aren't linked from index.html, only from the manifest
  const manifestLink = html.match(/<link rel="manifest" href="([^"]+)"/);
  if (manifestLink) {
    const manifestUrl = new URL(manifestLink[1], INDEX_URL).href;
    const manifest = await (await cache.match(manifestUrl)).json();
    const icons = (manifest.icons || []).map(icon => new URL(icon.src, manifestUrl).href);
    icons.forEach(url => urls.add(url));
    await Promise.all(icons.map(url => saveFile(cache, url)));
  }

  await cache.put(INDEX_URL, indexResponse);
  const keep = new Set([INDEX_URL, ...urls]);
  for (const req of await cache.keys()) {
    if (!keep.has(req.url)) await cache.delete(req);
  }
}

// a file the app needs, unless it's saved already (?v=N URLs never change)
async function saveFile(cache, url) {
  if (await cache.match(url)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  await cache.put(url, res);
}
