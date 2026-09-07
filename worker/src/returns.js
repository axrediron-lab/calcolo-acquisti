import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { drivePreview } from "./drive.js";
import { hash, parseReadyReturns, reject } from "./ready-csv.js";
import { purchaseBody } from "./purchases.js";

const RETURN_HEADER = '"Data";"N.Doc.";"Cod.";"Descrizione";"Quant."';
const MAX_PREVIEW_BYTES = 600 * 1024;

function db(env) {
  if (!env.PURCHASES_DB) reject("DATABASE_NOT_CONFIGURED", "Archivio online non configurato", 503);
  return env.PURCHASES_DB;
}

const mac = (text, env) => createHmac("sha256", env.APP_ACCESS_KEY).update("return-preview-v1:" + text).digest();
function seal(batch, env) {
  const encoded = Buffer.from(JSON.stringify({ version: 1, expires: Date.now() + 3600000, batch })).toString("base64url");
  return encoded + "." + mac(encoded, env).toString("base64url");
}
function unseal(token, env) {
  if (typeof token !== "string" || token.length > 3 * 1024 * 1024) reject("INVALID_PREVIEW", "Anteprima non valida. Rileggi il file.", 400);
  const parts = token.split(".");
  const supplied = Buffer.from(parts[1] || "", "base64url");
  const expected = mac(parts[0], env);
  if (parts.length !== 2 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) reject("INVALID_PREVIEW", "Anteprima modificata. Rileggi il file.", 400);
  let value;
  try { value = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch { reject("INVALID_PREVIEW", "Anteprima non valida", 400); }
  if (value.version !== 1 || !Number.isFinite(value.expires) || value.expires < Date.now()) reject("PREVIEW_EXPIRED", "Anteprima scaduta. Rileggi il file.", 409);
  return value.batch;
}

async function mappingsFor(codes, database) {
  const { results } = await database.prepare("SELECT * FROM ready_mappings WHERE ready_code IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(codes)])).all();
  return new Map(results.map(row => [row.ready_code, row]));
}

function displayDate(value) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export async function previewReturns(payload, env) {
  const database = db(env);
  let csv;
  let source;
  if (payload.source === "drive") {
    const preview = await drivePreview(env, { fileName: env.DRIVE_RETURNS_FILE_NAME || "resi.CSV", expectedHeader: RETURN_HEADER });
    csv = preview.csv;
    source = { type: "drive", ...preview.file };
  } else if (payload.source === "upload" && typeof payload.csv === "string") {
    csv = payload.csv;
    source = { type: "upload", name: String(payload.name || "resi.CSV").slice(0, 200), sha256: hash(payload.csv) };
  } else reject("INVALID_SOURCE", "Seleziona Drive oppure un file CSV resi", 400);

  const batch = parseReadyReturns(csv);
  const mappings = await mappingsFor(batch.lines.map(line => line.ready_code), database);
  for (const line of batch.lines) {
    const mapping = mappings.get(line.ready_code);
    line.mapping = mapping?.listing_id ? { listing_id: mapping.listing_id, sku: mapping.sku, revision: mapping.revision } : null;
    line.mapping_revision = mapping?.revision || 0;
  }
  batch.source = source;
  batch.missing = batch.lines.filter(line => !line.mapping).length;
  const existing = await database.prepare("SELECT order_key,load_number FROM return_loads WHERE content_hash=?").bind(batch.hash).first();
  batch.status = existing ? "duplicate" : "new";
  batch.order_key = existing?.order_key || null;
  batch.load_number = existing?.load_number || null;
  if (Buffer.byteLength(JSON.stringify(batch)) > MAX_PREVIEW_BYTES) reject("DOCUMENT_LIMIT", "Carico resi troppo grande", 413);
  batch.token = batch.status === "new" && batch.missing === 0 ? seal(batch, env) : null;
  return { batch, source, backmarket_modified: false, prices_modified: false, costs_modified: false };
}

function groupedLines(batch) {
  const grouped = new Map();
  for (const line of batch.lines) {
    const listingId = String(line.mapping?.listing_id || "");
    if (!listingId) reject("MAPPING_REQUIRED", "Completa gli abbinamenti", 409);
    const current = grouped.get(listingId) || {
      listing_id: listingId,
      sku_snapshot: String(line.mapping.sku || ""),
      product_snapshot: line.description,
      quantity: 0,
      source_documents: [],
      ready_codes: [],
    };
    current.quantity += Number(line.quantity);
    for (const document of line.source_documents) if (!current.source_documents.includes(document)) current.source_documents.push(document);
    if (!current.ready_codes.includes(line.ready_code)) current.ready_codes.push(line.ready_code);
    grouped.set(listingId, current);
  }
  return [...grouped.values()];
}

export async function confirmReturnLoad(payload, env) {
  const database = db(env);
  if (payload.confirm !== true) reject("CONFIRM_REQUIRED", "Conferma il salvataggio del carico resi", 400);
  const batch = unseal(payload.token, env);
  if (!batch.lines?.length || batch.lines.some(line => !line.mapping)) reject("MAPPING_REQUIRED", "Completa gli abbinamenti", 409);
  const duplicate = await database.prepare("SELECT order_key,load_number FROM return_loads WHERE content_hash=?").bind(batch.hash).first();
  if (duplicate) return { ok: true, duplicate: true, ...duplicate, backmarket_modified: false };

  const sequenceRow = await database.prepare("SELECT coalesce(max(daily_sequence),0)+1 AS next_sequence FROM return_loads WHERE load_date=?").bind(batch.date).first();
  const sequence = Number(sequenceRow?.next_sequence || 1);
  const loadNumber = `CR-${batch.date}-${String(sequence).padStart(3, "0")}`;
  const orderKey = `return-${crypto.randomUUID()}`;
  const lines = groupedLines(batch);
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const now = new Date().toISOString();
  const title = `Carico resi ${displayDate(batch.date)}`;
  const revisions = [...new Map(batch.lines.map(line => [line.ready_code, { code: line.ready_code, revision: line.mapping.revision }])).values()];
  const sourceSnapshot = { source: batch.source, date: batch.date, rows: batch.row_count, units: batch.units, lines: batch.lines };
  const statements = [
    database.prepare(`INSERT INTO quantity_orders(order_key,order_number,order_type,title,document_date,line_count,units,created_at,source_type)
      SELECT ?,?,'quantity_only',?,?,?,?,?,'ready_return'
      WHERE NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN ready_mappings m ON m.ready_code=json_extract(j.value,'$.code')
        WHERE m.revision IS NULL OR m.revision<>json_extract(j.value,'$.revision') OR m.listing_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM return_loads WHERE content_hash=?)`)
      .bind(orderKey, loadNumber, title, batch.date, lines.length, units, now, JSON.stringify(revisions), batch.hash),
    ...lines.map(line => database.prepare(`INSERT INTO quantity_order_lines(order_key,listing_id,sku_snapshot,product_snapshot,quantity,source_orderline_ids_json)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM quantity_orders WHERE order_key=?)`)
      .bind(orderKey, line.listing_id, line.sku_snapshot, line.product_snapshot, line.quantity, JSON.stringify(line.source_documents), orderKey)),
    database.prepare(`INSERT INTO return_loads(order_key,load_number,load_date,daily_sequence,content_hash,source_name,source_modified_at,source_sha256,source_row_count,source_documents_json,source_json,recorded_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM quantity_orders WHERE order_key=?)`)
      .bind(orderKey, loadNumber, batch.date, sequence, batch.hash, String(batch.source?.name || "resi.CSV"), batch.source?.modified_at || null,
        String(batch.source?.sha256 || batch.hash), batch.row_count, JSON.stringify(batch.source_documents), JSON.stringify(sourceSnapshot), now, orderKey),
  ];
  try {
    const results = await database.batch(statements);
    const saved = await database.prepare("SELECT order_key,load_number FROM return_loads WHERE content_hash=?").bind(batch.hash).first();
    if (!saved) reject("MAPPING_CHANGED", "Gli abbinamenti sono cambiati dopo l’anteprima. Rileggi il file.", 409);
    return { ok: true, duplicate: results[0].meta.changes === 0, ...saved, line_count: lines.length, units, backmarket_modified: false, prices_modified: false, costs_modified: false };
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint")) {
      const saved = await database.prepare("SELECT order_key,load_number FROM return_loads WHERE content_hash=?").bind(batch.hash).first();
      if (saved) return { ok: true, duplicate: true, ...saved, backmarket_modified: false };
      reject("RETURN_SEQUENCE_CHANGED", "È stato creato un altro carico nello stesso momento. Rileggi il file e riprova.", 409);
    }
    throw error;
  }
}

async function status(database, env) {
  const row = await database.prepare("SELECT count(*) AS loads FROM return_loads").first();
  return { configured: true, loads: Number(row.loads || 0), drive_file_name: env.DRIVE_RETURNS_FILE_NAME || "resi.CSV", import_writes_stock: false };
}

async function loads(url, database) {
  const offset = Number(url.searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) reject("INVALID_PAGE", "Pagina non valida", 400);
  const { results } = await database.prepare(`SELECT r.order_key,r.load_number,r.load_date,r.source_name,r.source_row_count,r.recorded_at,
      q.line_count,q.units,
      (SELECT count(*) FROM quantity_order_processing p WHERE p.order_key=r.order_key) AS processed_items,
      (SELECT count(*) FROM quantity_order_processing p WHERE p.order_key=r.order_key AND p.quantity_status='applying') AS pending_items
    FROM return_loads r JOIN quantity_orders q ON q.order_key=r.order_key
    ORDER BY r.load_date DESC,r.daily_sequence DESC LIMIT 51 OFFSET ?`).bind(offset).all();
  return { results: results.slice(0, 50), next_offset: results.length > 50 ? offset + 50 : null };
}

export async function returnRoute(request, url, env) {
  const database = db(env);
  if (request.method === "GET") {
    if (url.pathname === "/api/returns/status") return status(database, env);
    if (url.pathname === "/api/returns/loads") return loads(url, database);
  }
  if (request.method === "POST") {
    if (url.pathname === "/api/returns/preview") return previewReturns(await purchaseBody(request), env);
    if (url.pathname === "/api/returns/confirm") return confirmReturnLoad(await purchaseBody(request), env);
  }
  reject("NOT_FOUND", "Operazione non disponibile", 404);
}
