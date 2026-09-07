const MARKETS = Object.freeze({
  IT: "EUR", AT: "EUR", BE: "EUR", ES: "EUR", FR: "EUR", FI: "EUR",
  GR: "EUR", IE: "EUR", NL: "EUR", PT: "EUR", SE: "SEK", SK: "EUR",
});
const OPEN_STATUSES = ["prepared", "active", "capturing", "restoring", "restore_required"];
const MAX_BODY = 16 * 1024;

export class BuyboxCaptureError extends Error {
  constructor(code, publicMessage, status = 400) {
    super(publicMessage); this.code = code; this.publicMessage = publicMessage; this.status = status;
  }
}
function reject(code, message, status = 400) { throw new BuyboxCaptureError(code, message, status); }
function db(env) { if (!env.PURCHASES_DB) reject("DATABASE_NOT_CONFIGURED", "Archivio online non configurato", 503); return env.PURCHASES_DB; }
function validId(value) { return /^[A-Za-z0-9-]{6,100}$/.test(String(value || "")); }
function text(value, fallback = "") { return String(value ?? fallback).trim().slice(0, 1000); }
function amount(value) {
  const raw = value && typeof value === "object" ? value.amount : value;
  const number = Number(String(raw ?? "").replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : null;
}
function currency(value, fallback) { return text(value && typeof value === "object" ? value.currency : fallback).toUpperCase(); }
function fixed(value) { return Number(value).toFixed(2); }
function sameMoney(left, right) { return Math.abs(Number(left) - Number(right)) < 0.005; }
async function requestBody(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) reject("BODY_LIMIT", "Richiesta troppo grande", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY) reject("BODY_LIMIT", "Richiesta troppo grande", 413);
  let value; try { value = JSON.parse(raw || "{}"); } catch { reject("INVALID_BODY", "Richiesta JSON non valida"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("INVALID_BODY", "Richiesta JSON non valida");
  return value;
}
function requireConfirmation(payload) { if (payload.confirm !== true) reject("CONFIRMATION_REQUIRED", "Conferma esplicita richiesta"); }

async function job(database, jobId) {
  if (!validId(jobId)) reject("INVALID_JOB", "Operazione non valida");
  const result = await database.prepare("SELECT * FROM buybox_capture_jobs WHERE job_id = ?").bind(jobId).first();
  if (!result) reject("JOB_NOT_FOUND", "Operazione non trovata", 404);
  return result;
}
async function markets(database, jobId) {
  return (await database.prepare("SELECT * FROM buybox_capture_markets WHERE job_id = ? ORDER BY market").bind(jobId).all()).results || [];
}
async function setStatus(database, jobId, status, fields = {}) {
  const now = new Date().toISOString();
  await database.prepare(`UPDATE buybox_capture_jobs SET status = ?, updated_at = ?, activated_at = COALESCE(?, activated_at), captured_at = COALESCE(?, captured_at), restored_at = COALESCE(?, restored_at), last_error = ? WHERE job_id = ?`)
    .bind(status, now, fields.activatedAt || null, fields.capturedAt || null, fields.restoredAt || null, fields.error || null, jobId).run();
}
function listingSnapshot(listing, market) {
  const price = amount(listing?.price), minimum = amount(listing?.min_price), maximum = amount(listing?.max_price);
  const expectedCurrency = MARKETS[market];
  const listingCurrency = currency(listing?.price, listing?.currency || expectedCurrency) || expectedCurrency;
  if (!price || !minimum || !maximum || listingCurrency !== expectedCurrency) reject("INCOMPLETE_MARKET_SNAPSHOT", `Prezzi incompleti o valuta non valida per ${market}`);
  if (price > maximum + 0.005 || minimum > price + 0.005) reject("INVALID_MARKET_SNAPSHOT", `Intervallo prezzi incoerente per ${market}`);
  return { market, currency: expectedCurrency, original_price: fixed(price), original_min_price: fixed(minimum), max_price: fixed(maximum), temporary_price: fixed(maximum) };
}

async function prepare(payload, database, operations) {
  requireConfirmation(payload);
  const listingId = text(payload.listing_id);
  if (!validId(listingId)) reject("INVALID_LISTING", "Inserzione non valida");
  const existing = await database.prepare("SELECT job_id,status FROM buybox_capture_jobs WHERE listing_id = ? AND status <> 'restored'").bind(listingId).first();
  if (existing) return { duplicate: true, job_id: existing.job_id, status: existing.status };
  const snapshots = [];
  let identity = null;
  for (const market of Object.keys(MARKETS)) {
    const listing = await operations.loadListing(listingId, market);
    if (Number(listing?.quantity) !== 0) reject("LISTING_HAS_STOCK", "L’inserzione non è più a quantità zero");
    const currentId = text(listing?.id, listingId);
    if (currentId && currentId !== listingId) reject("LISTING_CHANGED", "Identità inserzione non coerente");
    const current = { product_id: text(listing?.product_id ?? listing?.product?.id), sku: text(listing?.sku, listingId), product: text(listing?.product?.title ?? listing?.product_title ?? listing?.title ?? listing?.sku, "Prodotto Back Market") };
    if (!identity) identity = current;
    else if (identity.product_id && current.product_id && identity.product_id !== current.product_id) reject("LISTING_CHANGED", "Prodotto non coerente tra i mercati");
    snapshots.push(listingSnapshot(listing, market));
  }
  if (!identity?.product_id) reject("PRODUCT_ID_MISSING", "Product ID non disponibile");
  const now = new Date().toISOString(), jobId = crypto.randomUUID();
  await database.batch([
    database.prepare("INSERT INTO buybox_capture_jobs(job_id,listing_id,product_id,sku_snapshot,product_snapshot,original_quantity,status,created_at,updated_at) VALUES(?,?,?,?,?,?, 'prepared',?,?)")
      .bind(jobId, listingId, identity.product_id, identity.sku, identity.product, 0, now, now),
    ...snapshots.map(row => database.prepare("INSERT INTO buybox_capture_markets(job_id,market,currency,original_price,original_min_price,max_price,temporary_price) VALUES(?,?,?,?,?,?,?)")
      .bind(jobId, row.market, row.currency, row.original_price, row.original_min_price, row.max_price, row.temporary_price)),
  ]);
  return { job_id: jobId, status: "prepared", listing_id: listingId, product_id: identity.product_id, sku: identity.sku, product: identity.product, markets: snapshots, backmarket_modified: false };
}

async function restoreJob(record, database, operations) {
  if (record.status === "prepared") {
    const now = new Date().toISOString();
    await setStatus(database, record.job_id, "restored", { restoredAt: now });
    return { job_id: record.job_id, status: "restored", quantity: 0, restored_markets: 0, backmarket_modified: false };
  }
  const rows = await markets(database, record.job_id);
  await setStatus(database, record.job_id, "restoring");
  try {
    await operations.updateQuantity(record.listing_id, 0);
    for (const row of rows) await operations.updatePrice(record.listing_id, row.market, row.original_price, row.original_min_price, row.currency);
    for (const row of rows) {
      const current = await operations.loadListing(record.listing_id, row.market);
      if (Number(current?.quantity) !== 0 || !sameMoney(amount(current?.price), row.original_price) || !sameMoney(amount(current?.min_price), row.original_min_price)) reject("RESTORE_VERIFICATION_FAILED", `Ripristino non verificato per ${row.market}`, 502);
    }
    const now = new Date().toISOString();
    await setStatus(database, record.job_id, "restored", { restoredAt: now });
    return { job_id: record.job_id, status: "restored", quantity: 0, restored_markets: rows.length };
  } catch (error) {
    await setStatus(database, record.job_id, "restore_required", { error: text(error?.message, "Ripristino incompleto") });
    throw error;
  }
}

async function activate(payload, database, operations) {
  requireConfirmation(payload); const record = await job(database, text(payload.job_id));
  if (record.status === "active") return { duplicate: true, job_id: record.job_id, status: "active" };
  if (record.status !== "prepared") reject("INVALID_JOB_STATE", "L’operazione non è pronta per l’attivazione", 409);
  const rows = await markets(database, record.job_id);
  let writesStarted = false;
  try {
    for (const row of rows) {
      const current = await operations.loadListing(record.listing_id, row.market);
      if (Number(current?.quantity) !== 0 || !sameMoney(amount(current?.price), row.original_price) || !sameMoney(amount(current?.min_price), row.original_min_price)) reject("LISTING_CHANGED", `Prezzo o quantità modificati dopo la preparazione (${row.market})`, 409);
    }
    for (const row of rows) {
      writesStarted = true;
      await operations.updatePrice(record.listing_id, row.market, row.temporary_price, row.temporary_price, row.currency);
    }
    await operations.updateQuantity(record.listing_id, 1);
    const now = new Date().toISOString(); await setStatus(database, record.job_id, "active", { activatedAt: now });
    return { job_id: record.job_id, status: "active", temporary_quantity: 1, temporary_markets: rows.length };
  } catch (error) {
    if (writesStarted) {
      try { await restoreJob(record, database, operations); } catch { /* stato restore_required già registrato */ }
    } else {
      const now = new Date().toISOString();
      await setStatus(database, record.job_id, "restored", { restoredAt: now, error: text(error?.message, "Inserzione modificata dopo la preparazione") });
    }
    throw error;
  }
}

function classify(entry, market, temporaryPrice) {
  if (!entry) return { market, classification: "no_data", is_winning: null };
  if (entry.is_winning === true) return { market, classification: "own_winning", is_winning: 1 };
  const winner = amount(entry.winner_price), toWin = amount(entry.price_to_win);
  if (entry.is_winning !== false || (!winner && !toWin) || (winner && winner >= Number(temporaryPrice) - 0.005)) return { market, classification: "invalid", is_winning: entry.is_winning === false ? 0 : null };
  return {
    market, classification: "competitive", is_winning: 0,
    winner_amount: winner ? fixed(winner) : null, winner_currency: winner ? currency(entry.winner_price, MARKETS[market]) : null,
    price_to_win_amount: toWin ? fixed(toWin) : null, price_to_win_currency: toWin ? currency(entry.price_to_win, MARKETS[market]) : null,
  };
}

async function capture(payload, database, operations) {
  requireConfirmation(payload); const record = await job(database, text(payload.job_id));
  if (record.status !== "active") reject("INVALID_JOB_STATE", "L’inserzione non risulta attiva per la rilevazione", 409);
  const rows = await markets(database, record.job_id); await setStatus(database, record.job_id, "capturing");
  let observations = [];
  try {
    const data = await operations.loadBackbox(record.listing_id);
    const entries = Array.isArray(data) ? data : Array.isArray(data?.competitors) ? data.competitors : [];
    observations = rows.map(row => classify(entries.find(item => text(item?.market).toUpperCase() === row.market), row.market, row.temporary_price));
    const now = new Date().toISOString();
    await database.batch(observations.map(item => database.prepare("INSERT OR REPLACE INTO buybox_capture_observations(job_id,market,classification,is_winning,winner_amount,winner_currency,price_to_win_amount,price_to_win_currency,captured_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(record.job_id, item.market, item.classification, item.is_winning, item.winner_amount || null, item.winner_currency || null, item.price_to_win_amount || null, item.price_to_win_currency || null, now)));
    await setStatus(database, record.job_id, "capturing", { capturedAt: now });
  } finally {
    await restoreJob(record, database, operations);
  }
  return { job_id: record.job_id, status: "restored", competitive_markets: observations.filter(item => item.classification === "competitive").length, excluded_markets: observations.filter(item => item.classification !== "competitive").length, observations };
}

async function status(url, database) {
  const jobId = text(url.searchParams.get("job_id"));
  if (jobId) {
    const record = await job(database, jobId);
    return { job: record, markets: await markets(database, jobId), observations: (await database.prepare("SELECT * FROM buybox_capture_observations WHERE job_id = ? ORDER BY market").bind(jobId).all()).results || [] };
  }
  const open = (await database.prepare(`SELECT * FROM buybox_capture_jobs WHERE status IN (${OPEN_STATUSES.map(() => "?").join(",")}) ORDER BY created_at DESC`).bind(...OPEN_STATUSES).all()).results || [];
  const recent = (await database.prepare("SELECT * FROM buybox_capture_jobs WHERE status = 'restored' ORDER BY restored_at DESC LIMIT 20").all()).results || [];
  return { open, recent };
}

async function stock(url, database) {
  const ids = [...new Set(String(url.searchParams.get("listing_ids") || "").split(",").map(text).filter(validId))].slice(0, 100);
  if (!ids.length) return { results: {} };
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await database.prepare(`SELECT j.listing_id,o.market,o.winner_amount,o.winner_currency,o.price_to_win_amount,o.price_to_win_currency,o.captured_at FROM buybox_capture_observations o JOIN buybox_capture_jobs j ON j.job_id=o.job_id WHERE j.status='restored' AND o.classification='competitive' AND j.listing_id IN (${placeholders}) AND o.captured_at=(SELECT MAX(o2.captured_at) FROM buybox_capture_observations o2 JOIN buybox_capture_jobs j2 ON j2.job_id=o2.job_id WHERE j2.status='restored' AND o2.classification='competitive' AND j2.listing_id=j.listing_id AND o2.market=o.market)`).bind(...ids).all()).results || [];
  const results = {};
  for (const row of rows) {
    (results[row.listing_id] ||= { competitors: [], captured_at: row.captured_at }).competitors.push({ market: row.market, is_winning: false, winner_price: row.winner_amount ? { amount: row.winner_amount, currency: row.winner_currency } : null, price_to_win: row.price_to_win_amount ? { amount: row.price_to_win_amount, currency: row.price_to_win_currency } : null, source: "temporary_capture" });
  }
  return { results };
}

export async function buyboxCaptureRoute(request, url, env, operations) {
  const database = db(env);
  if (request.method === "GET" && url.pathname === "/api/buybox-captures/status") return status(url, database);
  if (request.method === "GET" && url.pathname === "/api/buybox-captures/stock") return stock(url, database);
  if (request.method !== "POST") reject("METHOD_NOT_ALLOWED", "Metodo non consentito", 405);
  const payload = await requestBody(request);
  if (url.pathname === "/api/buybox-captures/prepare") return prepare(payload, database, operations);
  if (url.pathname === "/api/buybox-captures/activate") return activate(payload, database, operations);
  if (url.pathname === "/api/buybox-captures/capture") return capture(payload, database, operations);
  if (url.pathname === "/api/buybox-captures/restore") { requireConfirmation(payload); return restoreJob(await job(database, text(payload.job_id)), database, operations); }
  reject("NOT_FOUND", "Endpoint non trovato", 404);
}
