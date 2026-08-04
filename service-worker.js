const CACHE_NAME = "atlas-3.0.0-alpha20-5";

const scopeUrl = new URL(self.registration.scope);
const assetUrl = path => new URL(path, scopeUrl).toString();

const APP_SHELL = [
  "",
  "index.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "version.json"
].map(assetUrl);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of APP_SHELL) {
        try {
          const response = await fetch(url, { cache: "reload" });
          if (response.ok) await cache.put(url, response);
        } catch (error) {
          console.warn("ATLAS install cache:", url, error);
        }
      }
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(key => key.startsWith("atlas-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  const isNavigation = request.mode === "navigate";
  const isFreshFile =
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/version.json") ||
    url.pathname.endsWith("/service-worker.js");

  if (isNavigation || isFreshFile) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, { cache: "no-store" });

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        } catch {
          return (
            await caches.match(request)
          ) || (
            await caches.match(assetUrl("index.html"))
          ) || new Response("ATLAS indisponível offline.", {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          });
        }
      })()
    );

    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);

      const network = fetch(request, { cache: "no-cache" })
        .then(async response => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      return cached || await network || new Response("", { status: 504 });
    })()
  );
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data === "CLEAR_ATLAS_CACHE") {
    event.waitUntil(
      caches.keys().then(keys =>
        Promise.all(keys.map(key => caches.delete(key)))
      )
    );
  }
});