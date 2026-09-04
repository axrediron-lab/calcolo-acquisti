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
export async function purchaseRoute(request, url, env, loadListing) {
  const database = db(env);
  const path = url.pathname;
  if (request.method === "GET") {
    if (path === "/api/purchases/status") {
      const row = await database.prepare("SELECT count(*) AS documents FROM purchase_documents").first();
      return { configured: true, documents: row.documents, stock_writes_enabled: false };
    }
    if (path === "/api/purchases/documents") {
      const { q, offset } = searchParams(url);
      const { results } = await database.prepare(`SELECT document_key,document_number,document_date,row_count,units,total_cents,recorded_at,stock_status
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
    if (path === "/api/mappings/save") return saveMapping(await purchaseBody(request), env, loadListing);
  }
  reject("NOT_FOUND", "Operazione non disponibile", 404);
}
