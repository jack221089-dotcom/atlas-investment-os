const CACHE_NAME = "atlas-3.0.0-alpha18";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/version.json"
];

self.addEventListener("install", event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of APP_SHELL) {
        try {
          await cache.add(new Request(url, { cache: "reload" }));
        } catch (error) {
          console.warn("ATLAS cache install:", url, error);
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
          .filter(key => key !== CACHE_NAME)
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

  if (url.origin !== self.location.origin) {
    return;
  }

  // Para páginas e ficheiros de versão, procura sempre primeiro na rede.
  if (
    request.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/version.json")
  ) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, { cache: "no-store" });

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        } catch (error) {
          return (
            await caches.match(request)
          ) || (
            await caches.match("/index.html")
          ) || new Response("ATLAS indisponível offline.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      })()
    );

    return;
  }

  // Para ícones e restantes ficheiros locais, usa cache mas atualiza em fundo.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);

      const networkPromise = fetch(request, { cache: "no-cache" })
        .then(async response => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        })
        .catch(() => null);

      return cached || await networkPromise || new Response("", {
        status: 504
      });
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