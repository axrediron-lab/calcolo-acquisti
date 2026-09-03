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

test("scarica tutte le pagine delle listings usando soltanto GET", async () => {
  const calls = [];
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
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, "Basic test-token");
    assert.equal(call.options.headers["Accept-Language"], "it-it");
  }
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
