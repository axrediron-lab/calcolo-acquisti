import { createHash, timingSafeEqual } from "node:crypto";
import { DriveError, drivePreview, driveStatus } from "./drive.js";
import { PurchaseError } from "./ready-csv.js";
import { purchaseRoute } from "./purchases.js";
import { CancellationError, cancellationRoute } from "./cancellations.js";
import { refreshExchangeRates, SettingsError, settingsRoute } from "./settings.js";

const DEFAULT_API_BASE = "https://www.backmarket.fr";
const CATALOG_TTL_SECONDS = 300;
const BACKBOX_TTL_SECONDS = 60;
const EMPTY_BACKBOX_TTL_SECONDS = 8;
const MAX_CATALOG_PAGES = 100;
const MAX_ORDER_DIAGNOSTIC_PAGES = 10;
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

async function readCachedResponse(cacheKey) {
  if (!cacheAvailable()) return null;
  return (await caches.default.match(new Request(cacheKey))) || null;
}

async function readCache(cacheKey) {
  const response = await readCachedResponse(cacheKey);
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
  else void operation;
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
    const cachedResponse = await readCachedResponse(cacheKey);
    if (cachedResponse) return cachedResponse;
  }
  const payload = await fetchCatalog(env);
  writeCache(cacheKey, payload, CATALOG_TTL_SECONDS, ctx);
  return jsonResponse(payload);
}

async function backboxResponse(url, listingId, env, ctx) {
  if (!validListingId(listingId)) {
    throw new HttpError(400, "Identificativo inserzione non valido", "INVALID_LISTING_ID");
  }
  const refresh = url.searchParams.get("refresh") === "1";
  const cacheKey = `https://calcolo-cache.internal/backbox/${encodeURIComponent(listingId)}`;
  if (!refresh) {
    const cached = await readCache(cacheKey);
    if (cached) return jsonResponse(cached);
  }

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
  writeCache(cacheKey, result, competitors.length ? BACKBOX_TTL_SECONDS : EMPTY_BACKBOX_TTL_SECONDS, ctx);
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

async function clearListingCaches(listingId) {
  if (!cacheAvailable()) return;
  await Promise.all([
    caches.default.delete(new Request("https://calcolo-cache.internal/catalog")),
    caches.default.delete(new Request(`https://calcolo-cache.internal/backbox/${encodeURIComponent(listingId)}`)),
  ]);
}

async function updateListingResponse(request, listingId, env) {
  if (!validListingId(listingId)) {
    throw new HttpError(400, "Identificativo inserzione non valido", "INVALID_LISTING_ID");
  }
  const body = await jsonRequestBody(request);
  const update = updatePayload(body);
  const locale = update.market ? MARKET_CONFIG[update.market].locale : env.BACKMARKET_ACCEPT_LANGUAGE || "it-it";
  const upstream = absoluteBackMarketUrl(`/ws/listings/${encodeURIComponent(listingId)}`, env);
  const listing = await backMarketJson(upstream, env, { method: "POST", locale, body: update.output });
  await clearListingCaches(listingId);
  return jsonResponse({ ok: true, market: update.market, listing });
}

function diagnosticPageResponse() {
  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Verifica ordini Back Market</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b172a;background:#f3f7fb}
    *{box-sizing:border-box}body{margin:0;padding:32px 18px}.card{max-width:820px;margin:auto;background:#fff;border:1px solid #d7e2ee;border-radius:22px;padding:28px;box-shadow:0 18px 48px rgba(29,55,86,.1)}
    .eyebrow{margin:0 0 6px;color:#086796;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}h1{font-size:30px;line-height:1.15;margin:0 0 8px}p{color:#526985;line-height:1.5}label{display:block;font-weight:750;margin:18px 0 7px}input{width:100%;min-height:46px;border:1px solid #c9d8e7;border-radius:12px;padding:10px 12px;font:inherit}button{margin-top:20px;border:0;border-radius:12px;background:#086b9f;color:#fff;font:inherit;font-weight:800;padding:13px 18px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.notice{border-left:4px solid #0877ac;background:#eaf6fc;padding:12px 14px;color:#17334c}pre{display:none;white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f9fc;border:1px solid #d7e2ee;border-radius:14px;padding:16px;margin-top:22px;font-size:13px;line-height:1.5}.error{color:#a12a20}
  </style>
</head>
<body>
  <main class="card">
    <p class="eyebrow">Diagnosi in sola lettura</p>
    <h1>Verifica ordini Back Market</h1>
    <p class="notice">Non salva dati, non crea ordini e non modifica quantità o prezzi.</p>
    <form id="diagnosticForm">
      <label for="accessKey">Codice di accesso</label>
      <input id="accessKey" type="password" autocomplete="off" required>
      <label for="days">Intervallo in giorni</label>
      <input id="days" type="number" min="1" max="90" value="7" required>
      <button id="submitButton" type="submit">Esegui verifica</button>
    </form>
    <pre id="result" aria-live="polite"></pre>
  </main>
  <script>
    const form=document.getElementById("diagnosticForm"),result=document.getElementById("result"),button=document.getElementById("submitButton");
    form.addEventListener("submit",async event=>{
      event.preventDefault();button.disabled=true;result.style.display="block";result.className="";result.textContent="Lettura in corso…";
      const key=document.getElementById("accessKey").value,days=document.getElementById("days").value;
      try{
        const response=await fetch("/api/orders/diagnostic?days="+encodeURIComponent(days),{headers:{"X-App-Key":key,"Accept":"application/json"},cache:"no-store",credentials:"omit"});
        const payload=await response.json();
        if(!response.ok)throw new Error(payload.error||"Verifica non riuscita");
        result.textContent=JSON.stringify(payload,null,2);
      }catch(error){result.className="error";result.textContent=error.message||"Verifica non riuscita"}
      finally{document.getElementById("accessKey").value="";button.disabled=false}
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function diagnosticDays(url) {
  const raw = String(url.searchParams.get("days") || "7");
  if (!/^\d{1,2}$/.test(raw)) {
    throw new HttpError(400, "Intervallo diagnostico non valido", "INVALID_DIAGNOSTIC_WINDOW");
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new HttpError(400, "L’intervallo deve essere compreso tra 1 e 90 giorni", "INVALID_DIAGNOSTIC_WINDOW");
  }
  return days;
}

function cancellationActorEntries(value, path = "", depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => cancellationActorEntries(item, `${path}[]`, depth + 1));
  }
  const matches = [];
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
    if (normalizedKey === "canceledby" || normalizedKey === "cancelledby") {
      matches.push({ path: nextPath, value: nested });
    } else if (nested && typeof nested === "object") {
      matches.push(...cancellationActorEntries(nested, nextPath, depth + 1));
    }
  }
  return matches;
}

function actorCategory(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "missing";
  if (normalized.includes("client") || normalized.includes("customer")) return "client";
  if (normalized.includes("merchant") || normalized.includes("marchant")) return "merchant";
  return "other";
}

function diagnosticSample(order, orderline, actorEntries) {
  return {
    order_id: order?.order_id ?? null,
    orderline_id: orderline?.id ?? null,
    listing: String(orderline?.listing || "").slice(0, 160),
    product: String(orderline?.product || "").slice(0, 240),
    quantity: Number.isFinite(Number(orderline?.quantity)) ? Number(orderline.quantity) : null,
    order_modified_at: order?.date_modification || null,
    orderline_created_at: orderline?.date_creation || null,
    canceled_by: actorEntries.length ? String(actorEntries[0].value ?? "").slice(0, 80) : null,
  };
}

export async function fetchOrdersDiagnostic(url, env) {
  const days = diagnosticDays(url);
  const requestedAt = new Date();
  const from = new Date(requestedAt.getTime() - days * 24 * 60 * 60 * 1000);
  const firstPage = absoluteBackMarketUrl("/ws/orders", env);
  firstPage.searchParams.set("date_modification", from.toISOString());
  firstPage.searchParams.set("page-size", "50");

  let nextUrl = firstPage;
  let pages = 0;
  let reportedCount = null;
  let ordersRead = 0;
  let orderlinesRead = 0;
  let latestModifiedAt = null;
  const states = {};
  const actorPaths = new Set();
  const orderlineFields = new Set();
  const actors = { client: 0, merchant: 0, other: 0, missing: 0 };
  const samples = [];

  while (nextUrl && pages < MAX_ORDER_DIAGNOSTIC_PAGES) {
    const payload = await backMarketJson(nextUrl, env);
    const orders = Array.isArray(payload.results) ? payload.results : [];
    if (Number.isFinite(Number(payload.count))) reportedCount = Number(payload.count);

    for (const order of orders) {
      ordersRead += 1;
      const modifiedAt = typeof order?.date_modification === "string" ? order.date_modification : null;
      if (modifiedAt && (!latestModifiedAt || modifiedAt > latestModifiedAt)) latestModifiedAt = modifiedAt;
      const orderlines = Array.isArray(order?.orderlines) ? order.orderlines : [];
      for (const orderline of orderlines) {
        orderlinesRead += 1;
        Object.keys(orderline || {}).forEach(field => orderlineFields.add(field));
        const state = String(orderline?.state ?? "missing");
        states[state] = (states[state] || 0) + 1;
        if (state !== "4") continue;

        const actorEntries = cancellationActorEntries(orderline);
        actorEntries.forEach(entry => actorPaths.add(entry.path));
        if (!actorEntries.length) actors.missing += 1;
        else actors[actorCategory(actorEntries[0].value)] += 1;
        if (samples.length < 10) samples.push(diagnosticSample(order, orderline, actorEntries));
      }
    }

    nextUrl = payload.next ? absoluteBackMarketUrl(payload.next, env) : null;
    pages += 1;
  }

  return {
    read_only: true,
    persisted: false,
    backmarket_modified: false,
    requested_at: requestedAt.toISOString(),
    window: { days, from: from.toISOString(), to: requestedAt.toISOString() },
    upstream: {
      reported_orders: reportedCount,
      pages_read: pages,
      orders_read: ordersRead,
      orderlines_read: orderlinesRead,
      complete: !nextUrl,
      latest_modified_at: latestModifiedAt,
    },
    orderline_states: states,
    cancellations_state_4: {
      count: states["4"] || 0,
      canceled_by_field_present: actorPaths.size > 0,
      actor_paths: [...actorPaths].sort(),
      actors,
      samples,
    },
    observed_orderline_fields: [...orderlineFields].sort(),
  };
}

async function ordersDiagnosticResponse(url, env) {
  return jsonResponse(await fetchOrdersDiagnostic(url, env));
}

async function fetchCancellationOrdersPage(input, env) {
  let upstream;
  if (input.nextUrl) {
    upstream = absoluteBackMarketUrl(input.nextUrl, env);
  } else {
    upstream = absoluteBackMarketUrl("/ws/orders", env);
    upstream.searchParams.set("date_modification", input.modifiedFrom);
    upstream.searchParams.set("page-size", String(input.pageSize || 50));
  }
  const payload = await backMarketJson(upstream, env);
  return {
    ...payload,
    next: payload.next ? absoluteBackMarketUrl(payload.next, env).href : null,
  };
}

async function updateListingQuantity(listingId, quantity, env) {
  if (!validListingId(listingId) || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new HttpError(400, "Quantità non valida", "INVALID_QUANTITY");
  }
  const upstream = absoluteBackMarketUrl(`/ws/listings/${encodeURIComponent(listingId)}`, env);
  const listing = await backMarketJson(upstream, env, { method: "POST", locale: env.BACKMARKET_ACCEPT_LANGUAGE || "it-it", body: { quantity } });
  await clearListingCaches(listingId);
  return listing;
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
    } else if (url.pathname === "/diagnostic-orders" && ["GET", "HEAD"].includes(request.method)) {
      response = diagnosticPageResponse();
    } else if (url.pathname === "/api/settings" || url.pathname.startsWith("/api/settings/")) {
      if (!env.APP_ACCESS_KEY) throw new HttpError(503, "Servizio non ancora configurato", "NOT_CONFIGURED");
      assertAuthorized(request, env);
      response = jsonResponse(await settingsRoute(request, url, env));
    } else if (url.pathname.startsWith("/api/cancellations/")) {
      if (!env.APP_ACCESS_KEY) throw new HttpError(503, "Servizio non ancora configurato", "NOT_CONFIGURED");
      assertAuthorized(request, env);
      response = jsonResponse(await cancellationRoute(request, url, env, {
        fetchOrdersPage: input => {
          assertConfigured(env);
          return fetchCancellationOrdersPage(input, env);
        },
        loadListing: listingId => {
          assertConfigured(env);
          return backMarketJson(absoluteBackMarketUrl(`/ws/listings/${encodeURIComponent(listingId)}`, env), env, { locale: "it-it" });
        },
        updateQuantity: (listingId, quantity) => {
          assertConfigured(env);
          return updateListingQuantity(listingId, quantity, env);
        },
      }));
    } else if (url.pathname.startsWith("/api/purchases/") || url.pathname === "/api/mappings" || url.pathname.startsWith("/api/mappings/")) {
      if (!env.APP_ACCESS_KEY) throw new HttpError(503, "Servizio non ancora configurato", "NOT_CONFIGURED");
      assertAuthorized(request, env);
      response = jsonResponse(await purchaseRoute(request, url, env, {
        loadListing: async listingId => {
          assertConfigured(env);
          return backMarketJson(absoluteBackMarketUrl(`/ws/listings/${encodeURIComponent(listingId)}`, env), env, { locale: "it-it" });
        },
        updateQuantity: async (listingId, quantity) => {
          assertConfigured(env);
          return updateListingQuantity(listingId, quantity, env);
        },
      }));
    } else if (url.pathname === "/api/drive/status" || url.pathname === "/api/drive/preview") {
      if (!env.APP_ACCESS_KEY) throw new HttpError(503, "Servizio non ancora configurato", "NOT_CONFIGURED");
      assertAuthorized(request, env);
      if (request.method !== "GET") throw new HttpError(405, "È consentita soltanto la lettura GET", "METHOD_NOT_ALLOWED");
      response = jsonResponse(url.pathname.endsWith("/status") ? driveStatus(env) : await drivePreview(env));
    } else {
      assertConfigured(env);
      assertAuthorized(request, env);
      if (url.pathname === "/api/catalog" && ["GET", "HEAD"].includes(request.method)) {
        response = await catalogResponse(url, env, ctx);
      } else if (url.pathname === "/api/orders/diagnostic" && ["GET", "HEAD"].includes(request.method)) {
        response = await ordersDiagnosticResponse(url, env);
      } else if (url.pathname.startsWith("/api/backbox/") && ["GET", "HEAD"].includes(request.method)) {
        const listingId = decodeURIComponent(url.pathname.slice("/api/backbox/".length));
        response = await backboxResponse(url, listingId, env, ctx);
      } else if (url.pathname.startsWith("/api/listings/")) {
        const listingId = decodeURIComponent(url.pathname.slice("/api/listings/".length));
        response = request.method === "POST"
          ? await updateListingResponse(request, listingId, env)
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
    if (error instanceof DriveError || error instanceof PurchaseError || error instanceof SettingsError || error instanceof CancellationError) error = new HttpError(error.status, error.publicMessage, error.code);
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.publicMessage : "Errore interno del servizio";
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    console.error(JSON.stringify({ event: "request_error", request_id: requestId, path: url.pathname, status, code, duration_ms: Date.now() - startedAt, details: error instanceof HttpError ? error.details : {} }));
    const response = jsonResponse({ error: message, code, request_id: requestId }, status, status === 405 ? { Allow: url.pathname.startsWith("/api/drive/") ? "GET, OPTIONS" : "GET, HEAD, POST, OPTIONS" } : {});
    return addCors(response, request, env);
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshExchangeRates(env).catch(error => {
      console.error(JSON.stringify({ event: "exchange_rate_refresh_error", code: error?.code || "INTERNAL_ERROR" }));
    }));
  },
};
