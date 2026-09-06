import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest } from "../src/index.js";

const env = {
  BACKMARKET_TOKEN: "test-token",
  BACKMARKET_USER_AGENT: "BM-Test-CalcoloAcquisti;test@example.com",
  APP_ACCESS_KEY: "a-long-test-access-key",
  BACKMARKET_API_BASE: "https://www.backmarket.fr",
  BACKMARKET_ACCEPT_LANGUAGE: "it-it",
  ALLOWED_ORIGINS: "https://axrediron-lab.github.io,http://localhost:8000",
};

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
});

test("espone il gestore fetch richiesto dal runtime Cloudflare", async () => {
  const response = await worker.fetch(new Request("https://worker.test/health"), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("rifiuta richieste catalogo senza codice applicativo", async () => {
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response("{}");
  };
  const response = await handleRequest(new Request("https://worker.test/api/catalog", {
    headers: { Origin: "https://axrediron-lab.github.io" },
  }), env);
  assert.equal(response.status, 401);
  assert.equal(upstreamCalls, 0);
  assert.equal((await response.json()).code, "ACCESS_REQUIRED");
});

test("restituisce il catalogo cached senza parse e nuova serializzazione", async () => {
  let cachedJsonReads = 0;
  let upstreamCalls = 0;
  const cachedPayload = {
    updated_at: "2026-09-06T12:00:00.000Z",
    total: 1,
    pages: 1,
    results: [{ id: "listing-cached", sku: "CACHE" }],
  };
  globalThis.caches = {
    default: {
      match: async () => {
        const response = new Response(JSON.stringify(cachedPayload), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
        response.json = async () => {
          cachedJsonReads += 1;
          throw new Error("Il catalogo cached non deve essere deserializzato");
        };
        return response;
      },
      put: async () => undefined,
      delete: async () => true,
    },
  };
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response("{}");
  };

  const response = await handleRequest(new Request("https://worker.test/api/catalog", {
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), cachedPayload);
  assert.equal(cachedJsonReads, 0);
  assert.equal(upstreamCalls, 0);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://axrediron-lab.github.io");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("HEAD del catalogo cached conserva status e header senza body", async () => {
  let cachedJsonReads = 0;
  globalThis.caches = {
    default: {
      match: async () => {
        const response = new Response('{"total":1}', {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
        response.json = async () => {
          cachedJsonReads += 1;
          throw new Error("HEAD non deve deserializzare il catalogo cached");
        };
        return response;
      },
      put: async () => undefined,
      delete: async () => true,
    },
  };

  const response = await handleRequest(new Request("https://worker.test/api/catalog", {
    method: "HEAD",
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(cachedJsonReads, 0);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://axrediron-lab.github.io");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("scarica tutte le pagine delle listings usando soltanto GET", async () => {
  const calls = [];
  let cacheReads = 0;
  let cacheWrites = 0;
  globalThis.caches = {
    default: {
      match: async () => {
        cacheReads += 1;
        return new Response('{"results":[{"id":"stale"}]}');
      },
      put: async () => { cacheWrites += 1; },
      delete: async () => true,
    },
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const pageTwo = String(url).includes("page=2");
    return new Response(JSON.stringify(pageTwo ? {
      count: 2,
      next: null,
      results: [{ id: "listing-b", sku: "B" }],
    } : {
      count: 2,
      next: "/ws/listings?page=2&page-size=50",
      results: [{ id: "listing-a", sku: "A" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const response = await handleRequest(new Request("https://worker.test/api/catalog?refresh=1", {
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.results.length, 2);
  assert.equal(payload.pages, 2);
  assert.equal(calls.length, 2);
  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 1);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, "Basic test-token");
    assert.equal(call.options.headers["Accept-Language"], "it-it");
  }
});

test("espone la pagina diagnostica senza incorporare credenziali", async () => {
  const response = await handleRequest(new Request("https://worker.test/diagnostic-orders"), env);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/html/);
  assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'self'/);
  assert.match(html, /Verifica ordini Back Market/);
  assert.match(html, /\/api\/orders\/diagnostic/);
  assert.doesNotMatch(html, /test-token|a-long-test-access-key|test@example/);
});

test("la diagnosi ordini legge solo la finestra richiesta e non salva dati", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const pageTwo = String(url).includes("page=2");
    return new Response(JSON.stringify(pageTwo ? {
      count: 2,
      next: null,
      results: [{
        order_id: 102,
        date_modification: "2026-09-06T11:00:00Z",
        orderlines: [{ id: 1002, state: 5, listing: "SKU-B", product: "Prodotto B", quantity: 1 }],
      }],
    } : {
      count: 2,
      next: "/ws/orders?page=2&date_modification=2026-08-30T12%3A00%3A00.000Z&page-size=50",
      results: [{
        order_id: 101,
        date_modification: "2026-09-06T10:00:00Z",
        orderlines: [{ id: 1001, state: 4, listing: "SKU-A", product: "Prodotto A", quantity: 2, canceled_by: "Client" }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const response = await handleRequest(new Request("https://worker.test/api/orders/diagnostic?days=7", {
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.read_only, true);
  assert.equal(payload.persisted, false);
  assert.equal(payload.backmarket_modified, false);
  assert.equal(payload.upstream.pages_read, 2);
  assert.equal(payload.upstream.orders_read, 2);
  assert.equal(payload.orderline_states[4], 1);
  assert.equal(payload.orderline_states[5], 1);
  assert.equal(payload.cancellations_state_4.canceled_by_field_present, true);
  assert.equal(payload.cancellations_state_4.actors.client, 1);
  assert.equal(payload.cancellations_state_4.samples[0].orderline_id, 1001);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/ws\/orders\?/);
  assert.match(calls[0].url, /date_modification=/);
  assert.match(calls[0].url, /page-size=50/);
  for (const call of calls) assert.equal(call.options.method, "GET");
});

test("la diagnosi ordini non espone indirizzi o il payload completo", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    count: 1,
    next: null,
    results: [{
      order_id: 101,
      date_modification: "2026-09-06T10:00:00Z",
      shipping_address: { firstName: "Mario", lastName: "Rossi", street: "Via privata" },
      orderlines: [{ id: 1001, state: 4, listing: "SKU-A", product: "Prodotto A", quantity: 1 }],
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const response = await handleRequest(new Request("https://worker.test/api/orders/diagnostic?days=7", {
    headers: { "X-App-Key": env.APP_ACCESS_KEY },
  }), env);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(text, /Mario|Rossi|Via privata|shipping_address/);
});

test("la diagnosi ordini rifiuta finestre e metodi non consentiti", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
  const headers = { "X-App-Key": env.APP_ACCESS_KEY };

  const invalid = await handleRequest(new Request("https://worker.test/api/orders/diagnostic?days=365", { headers }), env);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_DIAGNOSTIC_WINDOW");

  const post = await handleRequest(new Request("https://worker.test/api/orders/diagnostic", { method: "POST", headers }), env);
  assert.equal(post.status, 404);
  assert.equal(calls, 0);
});

test("legge la BackBox della singola listing e inoltra il mercato", async () => {
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify([
      {
        market: "FR",
        winner_price: { amount: "420.00", currency: "EUR" },
        price_to_win: { amount: "418.00", currency: "EUR" },
      },
      {
        market: "IT",
        winner_price: { amount: "399.00", currency: "EUR" },
        price_to_win: { amount: "397.00", currency: "EUR" },
      },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const response = await handleRequest(new Request("https://worker.test/api/backbox/listing-123?market=IT", {
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedUrl, /\/ws\/backbox\/v1\/competitors\/listing-123$/);
  assert.equal(payload.competitors.length, 2);
  assert.equal(payload.competitors[0].market, "FR");
  assert.equal(payload.competitors[1].winner_price.amount, "399.00");
});

test("tratta una BackBox assente come risultato vuoto", async () => {
  globalThis.fetch = async () => new Response("", { status: 404 });

  const response = await handleRequest(new Request("https://worker.test/api/backbox/listing-404?market=IT", {
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { competitors: [] });
});

test("può forzare la lettura BackBox ignorando una copia in cache", async () => {
  let upstreamCalls = 0;
  globalThis.caches = {
    default: {
      match: async () => new Response(JSON.stringify({ competitors: [{ market: "IT", cached: true }] })),
      put: async () => undefined,
      delete: async () => true,
    },
  };
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify([{ market: "IT", cached: false }]), { status: 200 });
  };
  const headers = {
    Origin: "https://axrediron-lab.github.io",
    "X-App-Key": env.APP_ACCESS_KEY,
  };

  const cachedResponse = await handleRequest(new Request("https://worker.test/api/backbox/listing-123", { headers }), env);
  assert.equal((await cachedResponse.json()).competitors[0].cached, true);
  assert.equal(upstreamCalls, 0);

  const freshResponse = await handleRequest(new Request("https://worker.test/api/backbox/listing-123?refresh=1", { headers }), env);
  assert.equal((await freshResponse.json()).competitors[0].cached, false);
  assert.equal(upstreamCalls, 1);
});

test("aggiorna prezzo minimo e target nel mercato selezionato", async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ id: "listing-123", price: "139.00", min_price: "129.00" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const response = await handleRequest(new Request("https://worker.test/api/listings/listing-123", {
    method: "POST",
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ market: "BE", price: "139", min_price: "129", currency: "EUR" }),
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(captured.url, "https://www.backmarket.fr/ws/listings/listing-123");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Accept-Language"], "fr-be");
  assert.deepEqual(JSON.parse(captured.options.body), { price: "139.00", min_price: "129.00", currency: "EUR" });
});

test("aggiorna la quantità globale senza confonderla con un mercato", async () => {
  let captured = null;
  const deletedKeys = [];
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async () => undefined,
      delete: async (request) => { deletedKeys.push(String(request.url)); return true; },
    },
  };
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ id: "listing-123", quantity: 7 }), { status: 200 });
  };
  const response = await handleRequest(new Request("https://worker.test/api/listings/listing-123", {
    method: "POST",
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ quantity: 7 }),
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(captured.options.body), { quantity: 7 });
  assert.equal(captured.options.headers["Accept-Language"], "it-it");
  assert.equal(deletedKeys.length, 2);
  assert.ok(deletedKeys.some((key) => key.endsWith("/catalog")));
  assert.ok(deletedKeys.some((key) => key.endsWith("/backbox/listing-123")));
});

test("legge i prezzi della listing esaurita nel singolo mercato", async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ id: "listing-123", quantity: 0, price: "1480", min_price: "1380" }), { status: 200 });
  };
  const response = await handleRequest(new Request("https://worker.test/api/listings/listing-123?market=SE", {
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
    },
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.market, "SE");
  assert.equal(payload.listing.quantity, 0);
  assert.equal(captured.options.headers["Accept-Language"], "sv-se");
});

test("rifiuta prezzi incompatibili con l'intervallo BackPricer", async () => {
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; return new Response("{}"); };
  const response = await handleRequest(new Request("https://worker.test/api/listings/listing-123", {
    method: "POST",
    headers: {
      Origin: "https://axrediron-lab.github.io",
      "X-App-Key": env.APP_ACCESS_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ market: "IT", price: "150", min_price: "100", currency: "EUR" }),
  }), env);
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, "INVALID_BACKPRICER_RANGE");
  assert.equal(upstreamCalls, 0);
});

test("la health mostra solo se i segreti sono configurati", async () => {
  const response = await handleRequest(new Request("https://worker.test/health"), env);
  const payload = await response.json();
  assert.deepEqual(payload.configured, {
    backmarket_token: true,
    backmarket_user_agent: true,
    app_access_key: true,
  });
  assert.doesNotMatch(JSON.stringify(payload), /test-token|test-access-key|test@example/);
});
