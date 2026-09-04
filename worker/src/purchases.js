import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { parseReady, reject, hash } from "./ready-csv.js";
import { drivePreview } from "./drive.js";

const MAX_BODY = 3 * 1024 * 1024;
const MAX_DOC_BYTES = 600 * 1024;
export async function purchaseBody(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) reject("BODY_LIMIT", "Richiesta troppo grande", 413);
  const reader = request.body?.getReader();
  if (!reader) reject("INVALID_BODY", "Richiesta vuota", 400);
  const decoder = new TextDecoder(); let text = "", size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); reject("BODY_LIMIT", "Richiesta troppo grande", 413); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { const body = JSON.parse(text); if (!body || Array.isArray(body) || typeof body !== "object") throw new Error(); return body; }
  catch { reject("INVALID_BODY", "Richiesta JSON non valida", 400); }
}
function db(env) {
  if (!env.PURCHASES_DB) reject("DATABASE_NOT_CONFIGURED", "Archivio acquisti non configurato", 503);
  return env.PURCHASES_DB;
}
const mac = (text, env) => createHmac("sha256", env.APP_ACCESS_KEY).update("purchase-preview-v1:" + text).digest();
function seal(doc, env) {
  const encoded = Buffer.from(JSON.stringify({ version: 1, expires: Date.now() + 3600000, doc })).toString("base64url");
  return encoded + "." + mac(encoded, env).toString("base64url");
}
function unseal(token, env) {
  if (typeof token !== "string" || token.length > MAX_BODY) reject("INVALID_PREVIEW", "Anteprima non valida. Rileggi il file.", 400);
  const parts = token.split(".");
  const supplied = Buffer.from(parts[1] || "", "base64url");
  const expected = mac(parts[0], env);
  if (parts.length !== 2 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) reject("INVALID_PREVIEW", "Anteprima modificata. Rileggi il file.", 400);
  let value;
  try { value = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch { reject("INVALID_PREVIEW", "Anteprima non valida", 400); }
  if (value.version !== 1 || value.expires < Date.now() || !Number.isFinite(value.expires)) reject("PREVIEW_EXPIRED", "Anteprima scaduta. Rileggi il file.", 409);
  return value.doc;
}
async function mappingsFor(codes, database) {
  const { results } = await database.prepare("SELECT * FROM ready_mappings WHERE ready_code IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(codes)])).all();
  return new Map(results.map(row => [row.ready_code, row]));
}
export async function previewPurchases(body, env) {
  const database = db(env);
  let csv, source;
  if (body.source === "drive") {
    const preview = await drivePreview(env); csv = preview.csv;
    source = { type: "drive", ...preview.file };
  } else if (body.source === "upload" && typeof body.csv === "string") {
    csv = body.csv;
    source = { type: "upload", name: String(body.name || "acquisti.CSV").slice(0, 200), sha256: hash(csv) };
  } else reject("INVALID_SOURCE", "Seleziona Drive oppure un file CSV", 400);
  const documents = parseReady(csv);
  const mappings = await mappingsFor(documents.flatMap(d => d.lines.map(l => l.ready_code)), database);
  const { results } = await database.prepare("SELECT document_key,content_hash FROM purchase_documents WHERE document_key IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(documents.map(d => d.key))).all();
  const existing = new Map(results.map(d => [d.document_key, d.content_hash]));
  for (const doc of documents) {
    doc.source = source;
    for (const line of doc.lines) {
      const m = mappings.get(line.ready_code);
      line.mapping = m?.listing_id ? { listing_id: m.listing_id, sku: m.sku, revision: m.revision } : null;
      line.mapping_revision = m?.revision || 0;
    }
    doc.status = existing.has(doc.key) ? (existing.get(doc.key) === doc.hash ? "duplicate" : "conflict") : "new";
    doc.missing = doc.lines.filter(l => !l.mapping).length;
    if (Buffer.byteLength(JSON.stringify(doc)) > MAX_DOC_BYTES) reject("DOCUMENT_LIMIT", `Documento ${doc.number} troppo grande. Contatta l’assistenza.`, 413);
    doc.token = doc.status === "new" && !doc.missing ? seal(doc, env) : null;
  }
  return { documents, source, stock_writes_enabled: false };
}
export async function confirmPurchase(body, env) {
  const database = db(env);
  if (body.confirm !== true) reject("CONFIRM_REQUIRED", "Conferma esplicitamente il salvataggio", 400);
  const doc = unseal(body.token, env);
  if (!doc.lines?.length || doc.lines.some(l => !l.mapping)) reject("MAPPING_REQUIRED", "Completa gli abbinamenti", 409);
  const revisions = [...new Map(doc.lines.map(l => [l.ready_code, { code: l.ready_code, revision: l.mapping.revision }])).values()];
  // Unique document key + conditional insert provide race-safe idempotency and mapping validation.
  const result = await database.prepare(`INSERT INTO purchase_documents
    (document_key,document_number,document_year,document_date,content_hash,source_json,references_json,lines_json,row_count,units,total_cents,recorded_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN ready_mappings m ON m.ready_code=json_extract(j.value,'$.code')
      WHERE m.revision IS NULL OR m.revision<>json_extract(j.value,'$.revision') OR m.listing_id IS NULL)
    ON CONFLICT(document_key) DO NOTHING`).bind(doc.key, doc.number, doc.year, doc.date, doc.hash,
      JSON.stringify(doc.source), JSON.stringify(doc.references), JSON.stringify(doc.lines), doc.lines.length,
      doc.units, doc.total_cents, new Date().toISOString(), JSON.stringify(revisions)).run();
  const saved = await database.prepare("SELECT document_key,content_hash FROM purchase_documents WHERE document_key=?").bind(doc.key).first();
  if (saved) {
    if (saved.content_hash !== doc.hash) reject("DOCUMENT_CONFLICT", "Documento già presente con contenuto diverso: nessuna sovrascrittura effettuata", 409);
    return { ok: true, duplicate: result.meta.changes === 0, document_key: doc.key, stock_status: "not_sent" };
  }
  reject("MAPPING_CHANGED", "Gli abbinamenti sono cambiati dopo l’anteprima. Rileggi il file prima di confermare.", 409);
}
export async function saveMapping(body, env, loadListing) {
  const database = db(env);
  const code = String(body.ready_code || "").trim();
  if (!code || code.length > 100 || /[\x00-\x1f]/.test(code) || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0 || body.confirm !== true) reject("INVALID_MAPPING", "Codice, revisione o conferma abbinamento non validi", 400);
  const description = String(body.ready_description || "").trim().slice(0, 2000);
  let listingId = null, sku = null;
  if (body.remove !== true) {
    listingId = String(body.listing_id || "");
    if (!/^[A-Za-z0-9-]{6,100}$/.test(listingId)) reject("INVALID_LISTING", "Seleziona una inserzione Back Market valida", 400);
    const listing = await loadListing(listingId);
    if (typeof listing.sku !== "string" || !listing.sku.trim() || listing.sku.length > 1000 || String(listing.id) !== listingId) reject("INVALID_LISTING", "Inserzione Back Market non verificabile", 502);
    sku = listing.sku;
  } else if (body.expected_revision === 0) reject("INVALID_MAPPING", "Abbinamento inesistente", 409);
  const operation = crypto.randomUUID(); const now = new Date().toISOString();
  let changes;
  try {
    const result = await database.batch([
      database.prepare(`INSERT INTO ready_mappings (ready_code,ready_description,listing_id,sku,revision,updated_at,operation_id)
        SELECT ?,?,?,?,1,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ready_mappings WHERE ready_code=? AND revision=?)
        ON CONFLICT(ready_code) DO UPDATE SET ready_description=excluded.ready_description,listing_id=excluded.listing_id,
        sku=excluded.sku,revision=ready_mappings.revision+1,updated_at=excluded.updated_at,operation_id=excluded.operation_id
        WHERE ready_mappings.revision=?`).bind(code, description, listingId, sku, now, operation, body.expected_revision, code, body.expected_revision, body.expected_revision),
      database.prepare(`INSERT INTO mapping_history (ready_code,ready_description,listing_id,sku,revision,changed_at)
        SELECT ready_code,ready_description,listing_id,sku,revision,updated_at FROM ready_mappings WHERE operation_id=?`).bind(operation),
    ]);
    changes = result[0].meta.changes;
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint")) reject("SKU_ALREADY_MAPPED", "Questo SKU è già associato a un altro codice Ready", 409);
    throw error;
  }
  if (!changes) reject("MAPPING_CHANGED", "Abbinamento modificato nel frattempo. Ricarica e riprova.", 409);
  return { ok: true, ready_code: code, sku, revision: body.expected_revision + 1, applies_to: "future_imports_only" };
}
function searchParams(url) {
  const q = String(url.searchParams.get("q") || "").slice(0, 100);
  const offset = Number(url.searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) reject("INVALID_PAGE", "Pagina non valida", 400);
  return { q, offset };
}
function documentItems(saved) {
  let lines;
  try { lines = JSON.parse(saved.lines_json); } catch { reject("INVALID_DOCUMENT", "Documento salvato non leggibile", 500); }
  if (!Array.isArray(lines) || !lines.length) reject("INVALID_DOCUMENT", "Documento salvato senza righe", 500);
  const items = new Map();
  for (const line of lines) {
    const listingId = String(line.mapping?.listing_id || "");
    if (!listingId) reject("INVALID_DOCUMENT", "Documento salvato senza abbinamento storico", 500);
    const quantity = Number(line.quantity); const unitCost = Number(line.unit_cost_cents);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(unitCost) || unitCost <= 0) reject("INVALID_DOCUMENT", "Riga documento non valida", 500);
    const current = items.get(listingId) || { listing_id: listingId, sku_snapshot: String(line.mapping.sku || ""), description: String(line.description || ""), ready_codes: [], incoming_quantity: 0, incoming_total_cents: 0 };
    current.incoming_quantity += quantity; current.incoming_total_cents += quantity * unitCost;
    if (!current.ready_codes.includes(line.ready_code)) current.ready_codes.push(line.ready_code);
    items.set(listingId, current);
  }
  return [...items.values()].map(item => ({ ...item, incoming_unit_cost_cents: Math.round(item.incoming_total_cents / item.incoming_quantity) }));
}
async function savedDocument(key, database) {
  const saved = await database.prepare("SELECT * FROM purchase_documents WHERE document_key=?").bind(key).first();
  if (!saved) reject("DOCUMENT_NOT_FOUND", "Documento non trovato", 404);
  return saved;
}
export async function workDocument(key, env) {
  const database = db(env); const saved = await savedDocument(key, database); const items = documentItems(saved);
  const ids = JSON.stringify(items.map(item => item.listing_id));
  const [{ results: costs }, { results: events }, { results: earlier }] = await Promise.all([
    database.prepare("SELECT * FROM product_costs WHERE listing_id IN (SELECT value FROM json_each(?))").bind(ids).all(),
    database.prepare("SELECT * FROM purchase_processing WHERE document_key=?").bind(key).all(),
    database.prepare(`SELECT json_extract(j.value,'$.mapping.listing_id') AS listing_id,d.document_key,d.document_number,d.document_date
      FROM purchase_documents d,json_each(d.lines_json) j
      WHERE json_extract(j.value,'$.mapping.listing_id') IN (SELECT value FROM json_each(?))
        AND (d.document_date<? OR (d.document_date=? AND d.document_key<?))
        AND NOT EXISTS(SELECT 1 FROM purchase_processing p WHERE p.document_key=d.document_key AND p.listing_id=json_extract(j.value,'$.mapping.listing_id'))
      ORDER BY d.document_date,d.document_key`).bind(ids, saved.document_date, saved.document_date, saved.document_key).all(),
  ]);
  const costMap = new Map(costs.map(row => [row.listing_id, row])); const eventMap = new Map(events.map(row => [row.listing_id, row])); const earlierMap = new Map();
  for (const row of earlier) if (!earlierMap.has(row.listing_id)) earlierMap.set(row.listing_id, row);
  return { document: { document_key: saved.document_key, document_number: saved.document_number, document_date: saved.document_date }, items: items.map(item => ({ ...item, cost: costMap.get(item.listing_id) || null, processing: eventMap.get(item.listing_id) || null, earlier_document: earlierMap.get(item.listing_id) || null })) };
}
async function completeAutomatic(event, database, operations) {
  const listing = await operations.loadListing(event.listing_id); const current = Number(listing.quantity);
  if (!Number.isSafeInteger(current) || current < 0) reject("INVALID_LISTING_QUANTITY", "Quantità Back Market non leggibile", 502);
  if (current !== event.target_quantity) {
    if (current !== event.bm_quantity_observed) reject("QUANTITY_CHANGED", `La quantità Back Market è cambiata da ${event.bm_quantity_observed} a ${current}. Ricarica prima di procedere.`, 409);
    await operations.updateQuantity(event.listing_id, event.target_quantity);
  }
  await database.prepare("UPDATE purchase_processing SET quantity_status='automatic',updated_at=? WHERE document_key=? AND listing_id=? AND quantity_status='applying'")
    .bind(new Date().toISOString(), event.document_key, event.listing_id).run();
  return { ...event, quantity_status: "automatic", duplicate: false };
}
export async function processPurchaseItem(body, env, operations) {
  const database = db(env); const key = String(body.document_key || ""); const listingId = String(body.listing_id || "");
  const mode = String(body.mode || "");
  if (!key || !/^[A-Za-z0-9-]{6,100}$/.test(listingId) || !["automatic","manual","prices_only"].includes(mode) || body.confirm !== true || !Number.isSafeInteger(body.expected_bm_quantity) || body.expected_bm_quantity < 0) reject("INVALID_PROCESSING", "Scelta di lavorazione non valida", 400);
  const existing = await database.prepare("SELECT * FROM purchase_processing WHERE document_key=? AND listing_id=?").bind(key, listingId).first();
  if (existing) {
    if (existing.quantity_status === "applying") return completeAutomatic(existing, database, operations);
    if (existing.quantity_status === "pending" && mode !== "prices_only") {
      const listing = await operations.loadListing(listingId); const current = Number(listing.quantity);
      if (current !== body.expected_bm_quantity) reject("QUANTITY_CHANGED", `La quantità Back Market è cambiata da ${body.expected_bm_quantity} a ${current}. Ricarica prima di procedere.`, 409);
      if (mode === "manual") {
        await database.prepare("UPDATE purchase_processing SET quantity_status='manual',bm_quantity_observed=?,target_quantity=?,updated_at=? WHERE document_key=? AND listing_id=? AND quantity_status='pending'")
          .bind(current, current, new Date().toISOString(), key, listingId).run();
        return { ...existing, quantity_status: "manual", target_quantity: current, duplicate: false };
      }
      const target = current + existing.incoming_quantity; const now = new Date().toISOString();
      await database.prepare("UPDATE purchase_processing SET quantity_status='applying',bm_quantity_observed=?,target_quantity=?,updated_at=? WHERE document_key=? AND listing_id=? AND quantity_status='pending'")
        .bind(current, target, now, key, listingId).run();
      return completeAutomatic({ ...existing, quantity_status: "applying", bm_quantity_observed: current, target_quantity: target }, database, operations);
    }
    return { ...existing, duplicate: true };
  }
  const saved = await savedDocument(key, database); const item = documentItems(saved).find(value => value.listing_id === listingId);
  if (!item) reject("ITEM_NOT_FOUND", "Articolo non presente nel documento", 404);
  const earlier = await database.prepare(`SELECT d.document_number FROM purchase_documents d,json_each(d.lines_json) j
    WHERE json_extract(j.value,'$.mapping.listing_id')=? AND (d.document_date<? OR (d.document_date=? AND d.document_key<?))
      AND NOT EXISTS(SELECT 1 FROM purchase_processing p WHERE p.document_key=d.document_key AND p.listing_id=?)
    ORDER BY d.document_date,d.document_key LIMIT 1`).bind(listingId, saved.document_date, saved.document_date, saved.document_key, listingId).first();
  if (earlier) reject("EARLIER_DOCUMENT_REQUIRED", `Lavora prima il documento ${earlier.document_number} per rispettare l’ordine dei costi.`, 409);
  const pending = await database.prepare("SELECT document_key FROM purchase_processing WHERE listing_id=? AND quantity_status='pending' LIMIT 1").bind(listingId).first();
  if (pending) reject("PENDING_QUANTITY", "Esiste già una quantità in sospeso per questo articolo. Completa prima quella lavorazione.", 409);
  const listing = await operations.loadListing(listingId); const current = Number(listing.quantity);
  if (!Number.isSafeInteger(current) || current < 0) reject("INVALID_LISTING_QUANTITY", "Quantità Back Market non leggibile", 502);
  if (current !== body.expected_bm_quantity) reject("QUANTITY_CHANGED", `La quantità Back Market è cambiata da ${body.expected_bm_quantity} a ${current}. Ricarica prima di procedere.`, 409);
  const profile = await database.prepare("SELECT * FROM product_costs WHERE listing_id=?").bind(listingId).first();
  const previousQuantity = mode === "manual" ? current - item.incoming_quantity : current;
  if (profile && previousQuantity < 0) reject("INVALID_MANUAL_QUANTITY", "La quantità attuale è inferiore a quella dell’ordine: non può comprenderla già.", 409);
  const denominator = previousQuantity + item.incoming_quantity;
  const average = profile ? Math.round((previousQuantity * profile.average_cost_cents + item.incoming_total_cents) / denominator) : item.incoming_unit_cost_cents;
  const target = mode === "manual" ? current : current + item.incoming_quantity;
  const status = mode === "automatic" ? "applying" : mode === "manual" ? "manual" : "pending";
  const revision = (profile?.revision || 0) + 1; const now = new Date().toISOString();
  try {
    await database.batch([
      database.prepare(`INSERT INTO product_costs (listing_id,sku_snapshot,average_cost_cents,revision,source_document_key,updated_at)
        SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM product_costs WHERE listing_id=? AND revision=?)
        ON CONFLICT(listing_id) DO UPDATE SET sku_snapshot=excluded.sku_snapshot,average_cost_cents=excluded.average_cost_cents,
        revision=product_costs.revision+1,source_document_key=excluded.source_document_key,updated_at=excluded.updated_at WHERE product_costs.revision=?`)
        .bind(listingId, String(listing.sku || item.sku_snapshot), average, revision, key, now, profile?.revision || 0, listingId, profile?.revision || 0, profile?.revision || 0),
      database.prepare(`INSERT INTO purchase_processing (document_key,listing_id,sku_snapshot,incoming_quantity,incoming_total_cents,previous_average_cost_cents,previous_quantity,new_average_cost_cents,bm_quantity_observed,target_quantity,quantity_status,cost_revision,processed_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM product_costs WHERE listing_id=? AND revision=? AND source_document_key=?`)
        .bind(key, listingId, String(listing.sku || item.sku_snapshot), item.incoming_quantity, item.incoming_total_cents, profile?.average_cost_cents || null, profile ? previousQuantity : null, average, current, target, status, revision, now, now, listingId, revision, key),
    ]);
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint")) return processPurchaseItem(body, env, operations);
    throw error;
  }
  const event = await database.prepare("SELECT * FROM purchase_processing WHERE document_key=? AND listing_id=?").bind(key, listingId).first();
  if (!event) reject("COST_CHANGED", "Il costo è stato aggiornato nel frattempo. Ricarica e riprova.", 409);
  return status === "applying" ? completeAutomatic(event, database, operations) : { ...event, duplicate: false };
}
export async function purchaseRoute(request, url, env, operationInput) {
  const database = db(env);
  const operations = typeof operationInput === "function" ? { loadListing: operationInput, updateQuantity: async () => reject("WRITE_UNAVAILABLE", "Aggiornamento quantità non disponibile", 503) } : operationInput;
  const path = url.pathname;
  if (request.method === "GET") {
    if (path === "/api/purchases/status") {
      const row = await database.prepare("SELECT count(*) AS documents FROM purchase_documents").first();
      return { configured: true, documents: row.documents, document_save_writes_stock: false, processing_quantity_writes_enabled: true };
    }
    if (path === "/api/purchases/work") return workDocument(url.searchParams.get("key") || "", env);
    if (path === "/api/purchases/costs") {
      const { results } = await database.prepare("SELECT listing_id,sku_snapshot,average_cost_cents,revision,updated_at FROM product_costs ORDER BY listing_id LIMIT 5000").all();
      return { results };
    }
    if (path === "/api/purchases/documents") {
      const { q, offset } = searchParams(url);
      const { results } = await database.prepare(`SELECT document_key,document_number,document_date,row_count,units,total_cents,recorded_at,stock_status,
        (SELECT count(DISTINCT json_extract(j.value,'$.mapping.listing_id')) FROM json_each(lines_json) j) AS item_count,
        (SELECT count(*) FROM purchase_processing p WHERE p.document_key=purchase_documents.document_key) AS processed_items,
        (SELECT count(*) FROM purchase_processing p WHERE p.document_key=purchase_documents.document_key AND p.quantity_status IN ('pending','applying')) AS pending_items
        FROM purchase_documents WHERE instr(document_number,?)>0 OR instr(references_json,?)>0
        ORDER BY document_date DESC,document_key LIMIT 51 OFFSET ?`).bind(q, q, offset).all();
      return { results: results.slice(0, 50), next_offset: results.length > 50 ? offset + 50 : null };
    }
    if (path === "/api/purchases/document") {
      const saved = await database.prepare("SELECT * FROM purchase_documents WHERE document_key=?").bind(url.searchParams.get("key") || "").first();
      if (!saved) reject("DOCUMENT_NOT_FOUND", "Documento non trovato", 404);
      return { ...saved, source: JSON.parse(saved.source_json), references: JSON.parse(saved.references_json), lines: JSON.parse(saved.lines_json), source_json: undefined, references_json: undefined, lines_json: undefined };
    }
    if (path === "/api/mappings") {
      const { q, offset } = searchParams(url);
      const { results } = await database.prepare(`SELECT ready_code,ready_description,listing_id,sku,revision,updated_at FROM ready_mappings
        WHERE instr(lower(ready_code),lower(?))>0 OR instr(lower(ready_description),lower(?))>0 OR instr(lower(coalesce(sku,'')),lower(?))>0
        ORDER BY ready_code LIMIT 51 OFFSET ?`).bind(q, q, q, offset).all();
      return { results: results.slice(0, 50), next_offset: results.length > 50 ? offset + 50 : null };
    }
    if (path === "/api/mappings/history") {
      const { results } = await database.prepare("SELECT * FROM mapping_history WHERE ready_code=? ORDER BY revision DESC LIMIT 100").bind(url.searchParams.get("code") || "").all();
      return { results };
    }
  }
  if (request.method === "POST") {
    if (path === "/api/purchases/preview") return previewPurchases(await purchaseBody(request), env);
    if (path === "/api/purchases/confirm") return confirmPurchase(await purchaseBody(request), env);
    if (path === "/api/purchases/process") return processPurchaseItem(await purchaseBody(request), env, operations);
    if (path === "/api/mappings/save") return saveMapping(await purchaseBody(request), env, operations.loadListing);
  }
  reject("NOT_FOUND", "Operazione non disponibile", 404);
}
