const MAX_BODY = 64 * 1024;
const MAX_SELECTION = 500;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 8;
const OVERLAP_MS = 24 * 60 * 60 * 1000;

export class CancellationError extends Error {
  constructor(code, publicMessage, status = 400) {
    super(publicMessage);
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

function reject(code, message, status = 400) {
  throw new CancellationError(code, message, status);
}

function db(env) {
  if (!env.PURCHASES_DB) reject("DATABASE_NOT_CONFIGURED", "Archivio online non configurato", 503);
  return env.PURCHASES_DB;
}

async function body(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) reject("BODY_LIMIT", "Richiesta troppo grande", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) reject("BODY_LIMIT", "Richiesta troppo grande", 413);
  try {
    const value = JSON.parse(text || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    reject("INVALID_BODY", "Richiesta JSON non valida", 400);
  }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function filters(url) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  const from = String(url.searchParams.get("from") || "");
  const to = String(url.searchParams.get("to") || "");
  const status = String(url.searchParams.get("status") || "pending");
  const offset = Number(url.searchParams.get("offset") || 0);
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) reject("INVALID_DATE_FILTER", "Intervallo date non valido");
  if (!['pending', 'assigned', 'baseline', 'all'].includes(status)) reject("INVALID_STATUS_FILTER", "Stato non valido");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) reject("INVALID_PAGE", "Pagina non valida");
  return { q, from, to, status, offset };
}

function text(value, fallback = "") {
  return String(value ?? fallback).trim().slice(0, 1000);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cancellationRecord(order, line, now, activatedAt) {
  if (String(line?.state ?? "") !== "4") return null;
  const orderlineId = positiveInteger(line?.id);
  const orderId = positiveInteger(order?.order_id ?? order?.id);
  const listingId = text(line?.listing_id);
  const quantity = positiveInteger(line?.quantity);
  const modifiedAt = iso(order?.date_modification ?? order?.updated_at ?? line?.date_modification);
  if (!orderlineId || !orderId || !/^[A-Za-z0-9-]{6,100}$/.test(listingId) || !quantity || !modifiedAt) return null;
  return {
    orderline_id: orderlineId,
    order_id: orderId,
    listing_id: listingId,
    sku_snapshot: text(line?.listing, listingId),
    product_snapshot: text(line?.product ?? line?.product_title ?? line?.listing, "Prodotto Back Market"),
    quantity,
    order_modified_at: modifiedAt,
    orderline_created_at: iso(line?.date_creation),
    return_reason: line?.return_reason !== null && line?.return_reason !== undefined && Number.isSafeInteger(Number(line.return_reason)) ? Number(line.return_reason) : null,
    processing_status: modifiedAt <= activatedAt ? "baseline" : "pending",
    discovered_at: now,
    updated_at: now,
  };
}

async function syncState(database) {
  return database.prepare("SELECT * FROM cancellation_sync_state WHERE singleton=1").first();
}

async function status(database) {
  const state = await syncState(database);
  if (!state) return { activated: false, counts: { pending: 0, assigned: 0, baseline: 0 } };
  const { results } = await database.prepare("SELECT processing_status,count(*) AS count FROM client_cancellations GROUP BY processing_status").all();
  const counts = { pending: 0, assigned: 0, baseline: 0 };
  for (const row of results) counts[row.processing_status] = Number(row.count || 0);
  return { activated: true, state, counts };
}

async function activate(payload, database) {
  if (payload.confirm !== true) reject("CONFIRM_REQUIRED", "Conferma l’avvio del monitoraggio");
  const now = new Date().toISOString();
  const result = await database.prepare(`INSERT INTO cancellation_sync_state
    (singleton,activated_at,checkpoint_at,sync_status) VALUES(1,?,?, 'idle')
    ON CONFLICT(singleton) DO NOTHING`).bind(now, now).run();
  const state = await syncState(database);
  return { ok: true, activated_now: result.meta.changes === 1, state, historical_rows_imported: false };
}

async function saveSync(database, records, state, nextUrl, startedFrom, upperBound, now) {
  const statements = [];
  if (records.length) {
    statements.push(database.prepare(`INSERT INTO client_cancellations
      (orderline_id,order_id,listing_id,sku_snapshot,product_snapshot,quantity,order_modified_at,orderline_created_at,return_reason,processing_status,discovered_at,updated_at)
      SELECT json_extract(value,'$.orderline_id'),json_extract(value,'$.order_id'),json_extract(value,'$.listing_id'),
        json_extract(value,'$.sku_snapshot'),json_extract(value,'$.product_snapshot'),json_extract(value,'$.quantity'),
        json_extract(value,'$.order_modified_at'),json_extract(value,'$.orderline_created_at'),json_extract(value,'$.return_reason'),
        json_extract(value,'$.processing_status'),json_extract(value,'$.discovered_at'),json_extract(value,'$.updated_at')
      FROM json_each(?) WHERE 1
      ON CONFLICT(orderline_id) DO UPDATE SET order_id=excluded.order_id,listing_id=excluded.listing_id,
        sku_snapshot=excluded.sku_snapshot,product_snapshot=excluded.product_snapshot,quantity=excluded.quantity,
        order_modified_at=excluded.order_modified_at,orderline_created_at=excluded.orderline_created_at,
        return_reason=excluded.return_reason,updated_at=excluded.updated_at`).bind(JSON.stringify(records)));
  }
  if (nextUrl) {
    statements.push(database.prepare(`UPDATE cancellation_sync_state SET sync_started_from=?,sync_upper_bound=?,next_url=?,
      last_attempt_at=?,sync_status='running',last_error=NULL WHERE singleton=1`)
      .bind(startedFrom, upperBound, nextUrl, now));
  } else {
    statements.push(database.prepare(`UPDATE cancellation_sync_state SET checkpoint_at=?,sync_started_from=NULL,sync_upper_bound=NULL,
      next_url=NULL,last_attempt_at=?,last_success_at=?,sync_status='idle',last_error=NULL WHERE singleton=1`)
      .bind(upperBound, now, now));
  }
  await database.batch(statements);
}

async function synchronize(database, operations) {
  const state = await syncState(database);
  if (!state) reject("NOT_ACTIVATED", "Attiva prima il monitoraggio. I dati precedenti resteranno esclusi.", 409);
  const now = new Date().toISOString();
  const upperBound = state.sync_upper_bound || now;
  const startedFrom = state.sync_started_from || new Date(new Date(state.checkpoint_at).getTime() - OVERLAP_MS).toISOString();
  let nextUrl = state.next_url || null;
  let pages = 0;
  let ordersRead = 0;
  let state4Read = 0;
  let invalidRows = 0;
  const records = [];
  try {
    while (pages < MAX_PAGES_PER_SYNC) {
      const payload = await operations.fetchOrdersPage({ nextUrl, modifiedFrom: startedFrom, modifiedTo: upperBound, pageSize: PAGE_SIZE });
      const orders = Array.isArray(payload.results) ? payload.results : [];
      ordersRead += orders.length;
      for (const order of orders) {
        for (const line of Array.isArray(order?.orderlines) ? order.orderlines : []) {
          if (String(line?.state ?? "") !== "4") continue;
          state4Read += 1;
          const record = cancellationRecord(order, line, now, state.activated_at);
          if (record) records.push(record); else invalidRows += 1;
        }
      }
      nextUrl = payload.next || null;
      pages += 1;
      if (!nextUrl) break;
    }
    await saveSync(database, records, state, nextUrl, startedFrom, upperBound, now);
  } catch (error) {
    await database.prepare("UPDATE cancellation_sync_state SET last_attempt_at=?,sync_status='error',last_error=? WHERE singleton=1")
      .bind(now, "Back Market non disponibile durante la sincronizzazione").run();
    throw error;
  }
  return {
    ok: true,
    complete: !nextUrl,
    pages_read: pages,
    orders_read: ordersRead,
    state_4_read: state4Read,
    valid_rows_seen: records.length,
    invalid_rows: invalidRows,
    backmarket_modified: false,
    next_action: nextUrl ? "continue_sync" : "review_pending",
    status: await status(database),
  };
}

async function items(url, database) {
  const { q, from, to, status: wanted, offset } = filters(url);
  const { results } = await database.prepare(`SELECT orderline_id,order_id,listing_id,sku_snapshot,product_snapshot,quantity,
    order_modified_at,processing_status,restoration_order_key FROM client_cancellations
    WHERE (?='all' OR processing_status=?)
      AND (?='' OR substr(order_modified_at,1,10)>=?) AND (?='' OR substr(order_modified_at,1,10)<=?)
      AND (instr(cast(order_id AS TEXT),?)>0 OR instr(cast(orderline_id AS TEXT),?)>0 OR instr(lower(sku_snapshot),lower(?))>0 OR instr(lower(product_snapshot),lower(?))>0)
    ORDER BY order_modified_at DESC,orderline_id DESC LIMIT 51 OFFSET ?`)
    .bind(wanted, wanted, from, from, to, to, q, q, q, q, offset).all();
  return { results: results.slice(0, 50), next_offset: results.length > 50 ? offset + 50 : null };
}

async function createOrder(payload, database) {
  if (payload.confirm !== true) reject("CONFIRM_REQUIRED", "Conferma la creazione dell’ordine di ripristino");
  if (!Array.isArray(payload.orderline_ids) || !payload.orderline_ids.length || payload.orderline_ids.length > MAX_SELECTION) reject("INVALID_SELECTION", `Seleziona da 1 a ${MAX_SELECTION} righe`);
  const ids = [...new Set(payload.orderline_ids.map(positiveInteger))];
  if (ids.some(value => !value) || ids.length !== payload.orderline_ids.length) reject("INVALID_SELECTION", "La selezione contiene righe non valide o duplicate");
  const idsJson = JSON.stringify(ids);
  const { results } = await database.prepare(`SELECT * FROM client_cancellations
    WHERE orderline_id IN (SELECT value FROM json_each(?)) AND processing_status='pending' ORDER BY orderline_id`).bind(idsJson).all();
  if (results.length !== ids.length) reject("SELECTION_CHANGED", "Una o più cancellazioni sono già state elaborate. Ricarica la pagina.", 409);
  const grouped = new Map();
  for (const row of results) {
    const current = grouped.get(row.listing_id) || { listing_id: row.listing_id, sku_snapshot: row.sku_snapshot, product_snapshot: row.product_snapshot, quantity: 0, source_orderline_ids: [] };
    current.quantity += Number(row.quantity);
    current.source_orderline_ids.push(row.orderline_id);
    grouped.set(row.listing_id, current);
  }
  const now = new Date().toISOString();
  const key = `cancel-${crypto.randomUUID()}`;
  const number = `RA-${now.slice(0, 10).replaceAll("-", "")}-${key.slice(-6).toUpperCase()}`;
  const lines = [...grouped.values()];
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const statements = [
    database.prepare(`INSERT INTO quantity_orders(order_key,order_number,order_type,title,document_date,line_count,units,created_at)
      SELECT ?,?,'quantity_only','Ripristino annullamenti cliente',?,?,?,?
      WHERE (SELECT count(*) FROM client_cancellations WHERE orderline_id IN (SELECT value FROM json_each(?)) AND processing_status='pending')=?`)
      .bind(key, number, now.slice(0, 10), lines.length, units, now, idsJson, ids.length),
    ...lines.map(line => database.prepare(`INSERT INTO quantity_order_lines(order_key,listing_id,sku_snapshot,product_snapshot,quantity,source_orderline_ids_json)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM quantity_orders WHERE order_key=?)`)
      .bind(key, line.listing_id, line.sku_snapshot, line.product_snapshot, line.quantity, JSON.stringify(line.source_orderline_ids), key)),
    database.prepare(`UPDATE client_cancellations SET processing_status='assigned',restoration_order_key=?,updated_at=?
      WHERE orderline_id IN (SELECT value FROM json_each(?)) AND processing_status='pending'
        AND EXISTS(SELECT 1 FROM quantity_orders WHERE order_key=?)`).bind(key, now, idsJson, key),
  ];
  const batch = await database.batch(statements);
  if (batch[0].meta.changes !== 1 || batch.at(-1).meta.changes !== ids.length) reject("SELECTION_CHANGED", "La selezione è cambiata durante la creazione. Ricarica la pagina.", 409);
  return { ok: true, order_key: key, order_number: number, line_count: lines.length, units, backmarket_modified: false, prices_modified: false };
}

export async function workQuantityOrder(key, env) {
  const database = db(env);
  const order = await database.prepare("SELECT * FROM quantity_orders WHERE order_key=?").bind(key).first();
  if (!order) return null;
  const { results } = await database.prepare(`SELECT l.*,p.quantity_status,p.bm_quantity_observed,p.target_quantity,p.processed_at,p.updated_at
    FROM quantity_order_lines l LEFT JOIN quantity_order_processing p ON p.order_key=l.order_key AND p.listing_id=l.listing_id
    WHERE l.order_key=? ORDER BY l.product_snapshot,l.sku_snapshot`).bind(key).all();
  return {
    document: { document_key: order.order_key, document_number: order.order_number, document_date: order.document_date, document_type: order.order_type, document_label: order.title },
    items: results.map(row => ({
      listing_id: row.listing_id,
      sku_snapshot: row.sku_snapshot,
      description: row.product_snapshot,
      incoming_quantity: row.quantity,
      source_orderline_ids: JSON.parse(row.source_orderline_ids_json),
      processing: row.quantity_status ? {
        document_key: key,
        listing_id: row.listing_id,
        quantity_status: row.quantity_status,
        bm_quantity_observed: row.bm_quantity_observed,
        target_quantity: row.target_quantity,
        processed_at: row.processed_at,
        updated_at: row.updated_at,
      } : null,
    })),
  };
}

async function completeAutomatic(event, database, operations) {
  const listing = await operations.loadListing(event.listing_id);
  const current = Number(listing.quantity);
  if (!Number.isSafeInteger(current) || current < 0) reject("INVALID_LISTING_QUANTITY", "Quantità Back Market non leggibile", 502);
  if (current !== event.target_quantity) {
    if (current !== event.bm_quantity_observed) reject("QUANTITY_CHANGED", `La quantità Back Market è cambiata da ${event.bm_quantity_observed} a ${current}. Ricarica prima di procedere.`, 409);
    await operations.updateQuantity(event.listing_id, event.target_quantity);
  }
  await database.prepare("UPDATE quantity_order_processing SET quantity_status='automatic',updated_at=? WHERE order_key=? AND listing_id=? AND quantity_status='applying'")
    .bind(new Date().toISOString(), event.order_key, event.listing_id).run();
  return { ...event, quantity_status: "automatic", duplicate: false, prices_modified: false };
}

export async function processQuantityOrderItem(payload, env, operations) {
  const database = db(env);
  const key = text(payload.document_key);
  const listingId = text(payload.listing_id);
  const mode = text(payload.mode);
  if (!key.startsWith("cancel-") || !/^[A-Za-z0-9-]{6,100}$/.test(listingId) || !["manual", "automatic"].includes(mode) || payload.confirm !== true || !Number.isSafeInteger(payload.expected_bm_quantity) || payload.expected_bm_quantity < 0) reject("INVALID_PROCESSING", "Scelta di lavorazione non valida");
  const existing = await database.prepare("SELECT * FROM quantity_order_processing WHERE order_key=? AND listing_id=?").bind(key, listingId).first();
  if (existing) {
    if (existing.quantity_status === "applying") return completeAutomatic(existing, database, operations);
    return { ...existing, duplicate: true, prices_modified: false };
  }
  const line = await database.prepare("SELECT * FROM quantity_order_lines WHERE order_key=? AND listing_id=?").bind(key, listingId).first();
  if (!line) reject("ITEM_NOT_FOUND", "Articolo non presente nell’ordine", 404);
  const listing = await operations.loadListing(listingId);
  const current = Number(listing.quantity);
  if (!Number.isSafeInteger(current) || current < 0) reject("INVALID_LISTING_QUANTITY", "Quantità Back Market non leggibile", 502);
  if (current !== payload.expected_bm_quantity) reject("QUANTITY_CHANGED", `La quantità Back Market è cambiata da ${payload.expected_bm_quantity} a ${current}. Ricarica prima di procedere.`, 409);
  const target = mode === "automatic" ? current + Number(line.quantity) : current;
  const state = mode === "automatic" ? "applying" : "manual";
  const now = new Date().toISOString();
  try {
    await database.prepare(`INSERT INTO quantity_order_processing
      (order_key,listing_id,sku_snapshot,incoming_quantity,bm_quantity_observed,target_quantity,quantity_status,processed_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(key, listingId, text(listing.sku, line.sku_snapshot), line.quantity, current, target, state, now, now).run();
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint")) return processQuantityOrderItem(payload, env, operations);
    throw error;
  }
  const event = await database.prepare("SELECT * FROM quantity_order_processing WHERE order_key=? AND listing_id=?").bind(key, listingId).first();
  return state === "applying" ? completeAutomatic(event, database, operations) : { ...event, duplicate: false, prices_modified: false };
}

export async function cancellationRoute(request, url, env, operations) {
  const database = db(env);
  if (request.method === "GET") {
    if (url.pathname === "/api/cancellations/status") return status(database);
    if (url.pathname === "/api/cancellations/items") return items(url, database);
  }
  if (request.method === "POST") {
    if (url.pathname === "/api/cancellations/activate") return activate(await body(request), database);
    if (url.pathname === "/api/cancellations/sync") return synchronize(database, operations);
    if (url.pathname === "/api/cancellations/restore") return createOrder(await body(request), database);
  }
  reject("NOT_FOUND", "Operazione non disponibile", 404);
}
