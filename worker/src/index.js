import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_API_BASE = "https://www.backmarket.fr";
const CATALOG_TTL_SECONDS = 300;
const BACKBOX_TTL_SECONDS = 60;
const MAX_CATALOG_PAGES = 100;
const MAX_REQUEST_BYTES = 16 * 1024;
const MARKET_CONFIG = Object.freeze({
  IT: { locale: "it-it", currency: "EUR" },
  AT: { locale: "de-at", currency: "EUR" },
  BE: { locale: "fr-be", currency: "EUR" },
  ES: { locale: "es-es", currency: "EUR" },
  FR: { locale: "fr-fr", currency: "EUR" },
  FI: { locale: "fi-fi", currency: "EUR" },
  GR: { locale: "el-gr", currency: "EUR" },
  IE: { locale: "en-ie", currency: "EUR" },
  NL: { locale: "nl-nl", currency: "EUR" },
  PT: { locale: "pt-pt", currency: "EUR" },
  SE: { locale: "sv-se", currency: "SEK" },
  SK: { locale: "sk-sk", currency: "EUR" },
});

class HttpError extends Error {
  constructor(status, publicMessage, code, details = {}) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
    this.code = code;
    this.details = details;
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requestOrigin(request) {
  return request.headers.get("Origin") || "";
}

function isAllowedOrigin(request, env) {
  const origin = requestOrigin(request);
  return !origin || allowedOrigins(env).includes(origin);
}

function addCors(response, request, env) {
  const origin = requestOrigin(request);
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "private, no-store");
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-App-Key");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function configurationStatus(env) {
  return {
    backmarket_token: Boolean(env.BACKMARKET_TOKEN),
    backmarket_user_agent: Boolean(env.BACKMARKET_USER_AGENT),
    app_access_key: Boolean(env.APP_ACCESS_KEY),
  };
}

function assertConfigured(env) {
  const status = configurationStatus(env);
  const missing = Object.entries(status).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new HttpError(503, "Servizio non ancora configurato", "NOT_CONFIGURED", { missing });
  }
}

export function verifyKey(provided, expected) {
  const providedHash = createHash("sha256").update(String(provided || ""), "utf8").digest();
  const expectedHash = createHash("sha256").update(String(expected || ""), "utf8").digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function assertAuthorized(request, env) {
  const provided = request.headers.get("X-App-Key") || "";
  if (!provided || !verifyKey(provided, env.APP_ACCESS_KEY)) {
    throw new HttpError(401, "Codice di accesso richiesto", "ACCESS_REQUIRED");
  }
}

function backMarketHeaders(env, locale) {
  return {
    Accept: "application/json",
    "Accept-Language": locale || env.BACKMARKET_ACCEPT_LANGUAGE || "it-it",
    Authorization: `Basic ${env.BACKMARKET_TOKEN}`,
    "User-Agent": env.BACKMARKET_USER_AGENT,
  };
}

async function backMarketJson(url, env, options = {}) {
  const headers = backMarketHeaders(env, options.locale);
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      response.status === 429 ? "Limite Back Market temporaneamente raggiunto" : "Back Market non disponibile",
      "BACKMARKET_ERROR",
      { upstream_status: response.status },
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new HttpError(502, "Risposta Back Market non valida", "INVALID_UPSTREAM_RESPONSE");
  }
  return payload;
}

async function jsonRequestBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Richiesta troppo grande", "REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Richiesta troppo grande", "REQUEST_TOO_LARGE");
  }
  try {
    const payload = JSON.parse(text || "{}");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid");
    return payload;
  } catch {
    throw new HttpError(400, "Dati della richiesta non validi", "INVALID_JSON");
  }
}

function cacheAvailable() {
  return typeof caches !== "undefined" && caches && caches.default;
}

async function readCache(cacheKey) {
  if (!cacheAvailable()) return null;
  const response = await caches.default.match(new Request(cacheKey));
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function writeCache(cacheKey, payload, ttlSeconds, ctx) {
  if (!cacheAvailable()) return;
  const response = jsonResponse(payload, 200, {
    "Cache-Control": `public, max-age=${ttlSeconds}`,
  });
  const operation = caches.default.put(new Request(cacheKey), response);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(operation);
}

function absoluteBackMarketUrl(value, env) {
  const base = new URL(env.BACKMARKET_API_BASE || DEFAULT_API_BASE);
  const resolved = new URL(value, base);
  if (resolved.origin !== base.origin) {
    throw new HttpError(502, "Indirizzo Back Market non valido", "INVALID_UPSTREAM_URL");
  }
  return resolved;
}

export async function fetchCatalog(env) {
  const results = [];
  let nextUrl = absoluteBackMarketUrl("/ws/listings?page-size=50", env);
  let pages = 0;
  let reportedCount = null;

  while (nextUrl && pages < MAX_CATALOG_PAGES) {
    const payload = await backMarketJson(nextUrl, env);
    const pageResults = Array.isArray(payload.results) ? payload.results : [];
    results.push(...pageResults);
    if (Number.isFinite(Number(payload.count))) reportedCount = Number(payload.count);
    nextUrl = payload.next ? absoluteBackMarketUrl(payload.next, env) : null;
    pages += 1;
  }

  if (nextUrl) {
    throw new HttpError(502, "Catalogo troppo grande per un singolo aggiornamento", "CATALOG_PAGE_LIMIT", {
      pages,
      partial_results: results.length,
    });
  }

  return {
    updated_at: new Date().toISOString(),
    total: reportedCount === null ? results.length : reportedCount,
    pages,
    results,
  };
}

function validListingId(value) {
  return /^[A-Za-z0-9-]{6,100}$/.test(value);
}

async function catalogResponse(url, env, ctx) {
  const refresh = url.searchParams.get("refresh") === "1";
  const cacheKey = "https://calcolo-cache.internal/catalog";
  if (!refresh) {
    const cached = await readCache(cacheKey);
    if (cached) return jsonResponse(cached);
  }
  const payload = await fetchCatalog(env);
  writeCache(cacheKey, payload, CATALOG_TTL_SECONDS, ctx);
  return jsonResponse(payload);
}

async function backboxResponse(url, listingId, env, ctx) {
  if (!validListingId(listingId)) {
    throw new HttpError(400, "Identificativo inserzione non valido", "INVALID_LISTING_ID");
  }
  const cacheKey = `https://calcolo-cache.internal/backbox/${encodeURIComponent(listingId)}`;
  const cached = await readCache(cacheKey);
  if (cached) return jsonResponse(cached);

  const upstream = absoluteBackMarketUrl(`/ws/backbox/v1/competitors/${encodeURIComponent(listingId)}`, env);
  let payload;
  try {
    payload = await backMarketJson(upstream, env);
  } catch (error) {
    if (error instanceof HttpError && error.details.upstream_status === 404) {
      payload = [];
    } else {
      throw error;
    }
  }

  const competitors = Array.isArray(payload) ? payload : [];
  const result = { competitors };
  writeCache(cacheKey, result, BACKBOX_TTL_SECONDS, ctx);
  return jsonResponse(result);
}

function requestedMarket(url) {
  const market = String(url.searchParams.get("market") || "IT").toUpperCase();
  const config = MARKET_CONFIG[market];
  if (!config) throw new HttpError(400, "Mercato non configurato", "INVALID_MARKET");
  return { market, ...config };
}

async function listingResponse(url, listingId, env) {
  if (!validListingId(listingId)) {
    throw new HttpError(400, "Identificativo inserzione non valido", "INVALID_LISTING_ID");
  }
  const market = requestedMarket(url);
  const upstream = absoluteBackMarketUrl(`/ws/listings/${encodeURIComponent(listingId)}`, env);
  const listing = await backMarketJson(upstream, env, { locale: market.locale });
  return jsonResponse({ market: market.market, listing });
}

function moneyString(value, field) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new HttpError(400, `${field} non valido`, "INVALID_PRICE");
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) {
    throw new HttpError(400, `${field} non valido`, "INVALID_PRICE");
  }
  return number.toFixed(2);
}

function updatePayload(body) {
  const hasQuantity = Object.prototype.hasOwnProperty.call(body, "quantity");
  const hasPrice = Object.prototype.hasOwnProperty.call(body, "price") || Object.prototype.hasOwnProperty.call(body, "min_price");
  if (!hasQuantity && !hasPrice) {
    throw new HttpError(400, "Nessuna modifica da applicare", "EMPTY_UPDATE");
  }

  const output = {};
  let market = null;
  if (hasQuantity) {
    const quantity = Number(body.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new HttpError(400, "Quantità non valida", "INVALID_QUANTITY");
    }
    output.quantity = quantity;
  }

  if (hasPrice) {
    market = String(body.market || "").toUpperCase();
    const config = MARKET_CONFIG[market];
    if (!config) throw new HttpError(400, "Mercato non configurato", "INVALID_MARKET");
    if (!Object.prototype.hasOwnProperty.call(body, "price") || !Object.prototype.hasOwnProperty.call(body, "min_price")) {
      throw new HttpError(400, "Prezzo minimo e target devono essere inviati insieme", "INCOMPLETE_PRICE_UPDATE");
    }
    const price = moneyString(body.price, "Prezzo target");
    const minimum = moneyString(body.min_price, "Prezzo minimo");
    const priceNumber = Number(price);
    const minimumNumber = Number(minimum);
    if (minimumNumber > priceNumber || minimumNumber * 1.08 + 0.000001 < priceNumber) {
      throw new HttpError(400, "Il target deve essere compreso tra il minimo e il minimo maggiorato dell’8%", "INVALID_BACKPRICER_RANGE");
    }
    const currency = String(body.currency || config.currency).toUpperCase();
    if (currency !== config.currency) {
      throw new HttpError(400, "Valuta non valida per il mercato", "INVALID_CURRENCY");
    }
    output.price = price;
    output.min_price = minimum;
    output.currency = currency;
  }
  return { output, market };
}

function clearListingCaches(listingId, ctx) {
  if (!cacheAvailable() || !ctx || typeof ctx.waitUntil !== "function") return;
  const operations = [
    caches.default.delete(new Request("https://calcolo-cache.internal/catalog")),
    caches.default.delete(new Request(`https://calcolo-cache.internal/backbox/${encodeURIComponent(listingId)}`)),
  ];
  ctx.waitUntil(Promise.all(operations));
}

async function updateListingResponse(request, listingId, env, ctx) {
  if (!validListingId(listingId)) {
    throw new HttpError(400, "Identificativo inserzione non valido", "INVALID_LISTING_ID");
  }
  const body = await jsonRequestBody(request);
  const update = updatePayload(body);
  const locale = update.market ? MARKET_CONFIG[update.market].locale : env.BACKMARKET_ACCEPT_LANGUAGE || "it-it";
  const upstream = absoluteBackMarketUrl(`/ws/listings/${encodeURIComponent(listingId)}`, env);
  const listing = await backMarketJson(upstream, env, { method: "POST", locale, body: update.output });
  clearListingCaches(listingId, ctx);
  return jsonResponse({ ok: true, market: update.market, listing });
}

function preflightResponse(request, env) {
  if (!isAllowedOrigin(request, env)) {
    return jsonResponse({ error: "Origine non autorizzata", code: "ORIGIN_DENIED" }, 403);
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": requestOrigin(request),
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

export async function handleRequest(request, env, ctx = {}) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS") return preflightResponse(request, env);
    if (!isAllowedOrigin(request, env)) {
      throw new HttpError(403, "Origine non autorizzata", "ORIGIN_DENIED");
    }
    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      throw new HttpError(405, "Metodo non consentito", "METHOD_NOT_ALLOWED");
    }

    let response;
    if (url.pathname === "/health" && ["GET", "HEAD"].includes(request.method)) {
      response = jsonResponse({ ok: true, configured: configurationStatus(env) });
    } else {
      assertConfigured(env);
      assertAuthorized(request, env);
      if (url.pathname === "/api/catalog" && ["GET", "HEAD"].includes(request.method)) {
        response = await catalogResponse(url, env, ctx);
      } else if (url.pathname.startsWith("/api/backbox/") && ["GET", "HEAD"].includes(request.method)) {
        const listingId = decodeURIComponent(url.pathname.slice("/api/backbox/".length));
        response = await backboxResponse(url, listingId, env, ctx);
      } else if (url.pathname.startsWith("/api/listings/")) {
        const listingId = decodeURIComponent(url.pathname.slice("/api/listings/".length));
        response = request.method === "POST"
          ? await updateListingResponse(request, listingId, env, ctx)
          : await listingResponse(url, listingId, env);
      } else {
        throw new HttpError(404, "Endpoint non trovato", "NOT_FOUND");
      }
    }

    console.log(JSON.stringify({ event: "request", request_id: requestId, path: url.pathname, status: response.status, duration_ms: Date.now() - startedAt }));
    const finalResponse = addCors(response, request, env);
    return request.method === "HEAD"
      ? new Response(null, { status: finalResponse.status, headers: finalResponse.headers })
      : finalResponse;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.publicMessage : "Errore interno del servizio";
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    console.error(JSON.stringify({ event: "request_error", request_id: requestId, path: url.pathname, status, code, duration_ms: Date.now() - startedAt, details: error instanceof HttpError ? error.details : {} }));
    const response = jsonResponse({ error: message, code, request_id: requestId }, status, status === 405 ? { Allow: "GET, HEAD, POST, OPTIONS" } : {});
    return addCors(response, request, env);
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
