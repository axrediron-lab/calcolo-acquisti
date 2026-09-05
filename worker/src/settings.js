const MAX_BODY_BYTES = 16 * 1024;
const ECONOMIC_KEY = "economic";

export const DEFAULT_SETTINGS = Object.freeze({
  fee12: "12",
  fee5: "5",
  investorFee: "1",
  storfundFee: "1,20",
  paymentFee: "1",
  importFee: "0",
  shipping: "16,50",
  shippingItaly: "7,50",
  minimumMargin: "5",
  targetMargin: "7,50",
  usdRate: "0,92",
  sekRate: "0,090",
});

const PERCENT_KEYS = new Set([
  "fee12", "fee5", "investorFee", "storfundFee", "paymentFee", "minimumMargin", "targetMargin",
]);
const AMOUNT_KEYS = new Set(["importFee", "shipping", "shippingItaly"]);
const RATE_KEYS = new Set(["usdRate", "sekRate"]);

export class SettingsError extends Error {
  constructor(code, publicMessage, status = 400) {
    super(publicMessage);
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new SettingsError(code, message, status);
}

async function settingsBody(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) fail("REQUEST_TOO_LARGE", "Richiesta troppo grande", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) fail("REQUEST_TOO_LARGE", "Richiesta troppo grande", 413);
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body;
  } catch {
    fail("INVALID_JSON", "Dati della richiesta non validi");
  }
}

function numberValue(value, label, { allowZero = true, maximum = 100000 } = {}) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) fail("INVALID_SETTING", `${label} non valido`);
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric > maximum || (allowZero ? numeric < 0 : numeric <= 0)) {
    fail("INVALID_SETTING", `${label} non valido`);
  }
  return String(value).trim();
}

export function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_SETTINGS", "Impostazioni non valide");
  const output = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) fail("MISSING_SETTING", "Completa tutte le impostazioni");
    if (PERCENT_KEYS.has(key)) output[key] = numberValue(input[key], key, { maximum: 100 });
    else if (AMOUNT_KEYS.has(key)) output[key] = numberValue(input[key], key);
    else if (RATE_KEYS.has(key)) output[key] = numberValue(input[key], key, { allowZero: false });
  }
  if (Number(output.minimumMargin.replace(",", ".")) > Number(output.targetMargin.replace(",", "."))) {
    fail("INVALID_MARGIN_RANGE", "Il margine minimo non può superare il margine obiettivo");
  }
  return output;
}

function parseStoredSettings(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function readEconomicSettings(env) {
  const row = await env.PURCHASES_DB.prepare("SELECT values_json,revision,updated_at FROM app_settings WHERE settings_key=?")
    .bind(ECONOMIC_KEY).first();
  return row ? {
    exists: true,
    settings: parseStoredSettings(row.values_json),
    revision: row.revision,
    updated_at: row.updated_at,
  } : {
    exists: false,
    settings: { ...DEFAULT_SETTINGS },
    revision: 0,
    updated_at: null,
  };
}

async function saveEconomicSettings(body, env) {
  if (body.confirm !== true) fail("CONFIRM_REQUIRED", "Conferma il salvataggio delle impostazioni");
  const expectedRevision = Number(body.expected_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("INVALID_REVISION", "Versione delle impostazioni non valida");
  const settings = validateSettings(body.settings);
  const now = new Date().toISOString();
  const operation = crypto.randomUUID();
  const values = JSON.stringify(settings);
  const write = expectedRevision === 0
    ? env.PURCHASES_DB.prepare(`INSERT INTO app_settings (settings_key,values_json,revision,updated_at,operation_id)
        VALUES (?,?,1,?,?) ON CONFLICT(settings_key) DO NOTHING`).bind(ECONOMIC_KEY, values, now, operation)
    : env.PURCHASES_DB.prepare(`UPDATE app_settings SET values_json=?,revision=revision+1,updated_at=?,operation_id=?
        WHERE settings_key=? AND revision=?`).bind(values, now, operation, ECONOMIC_KEY, expectedRevision);
  await env.PURCHASES_DB.batch([
    write,
    env.PURCHASES_DB.prepare(`INSERT INTO app_settings_history (settings_key,values_json,revision,changed_at)
      SELECT settings_key,values_json,revision,updated_at FROM app_settings WHERE settings_key=? AND operation_id=?
      ON CONFLICT(settings_key,revision) DO NOTHING`).bind(ECONOMIC_KEY, operation),
  ]);
  const saved = await env.PURCHASES_DB.prepare("SELECT values_json,revision,updated_at,operation_id FROM app_settings WHERE settings_key=?")
    .bind(ECONOMIC_KEY).first();
  if (!saved || saved.operation_id !== operation) fail("SETTINGS_CHANGED", "Le impostazioni sono cambiate in un’altra sessione. Ricarica la pagina.", 409);
  return { ok: true, exists: true, settings: parseStoredSettings(saved.values_json), revision: saved.revision, updated_at: saved.updated_at };
}

function validListingId(value) {
  return /^[A-Za-z0-9-]{6,100}$/.test(String(value || ""));
}

function marginValue(value, label) {
  return numberValue(value, label, { maximum: 100 });
}

async function listProductMargins(env) {
  const { results } = await env.PURCHASES_DB.prepare(`SELECT listing_id,sku_snapshot,minimum_margin,target_margin,revision,updated_at
    FROM product_margins ORDER BY updated_at DESC,listing_id LIMIT 5000`).all();
  return { results };
}

async function saveProductMargin(body, env) {
  if (body.confirm !== true) fail("CONFIRM_REQUIRED", "Conferma il salvataggio del margine");
  const listingId = String(body.listing_id || "");
  if (!validListingId(listingId)) fail("INVALID_LISTING_ID", "Identificativo inserzione non valido");
  const expectedRevision = Number(body.expected_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("INVALID_REVISION", "Versione del margine non valida");
  const current = await env.PURCHASES_DB.prepare("SELECT revision FROM product_margins WHERE listing_id=?").bind(listingId).first();

  if (body.remove === true) {
    if (!current) return { ok: true, removed: true, listing_id: listingId };
    if (current.revision !== expectedRevision) fail("MARGIN_CHANGED", "Il margine è cambiato in un’altra sessione. Ricarica la pagina.", 409);
    const result = await env.PURCHASES_DB.prepare("DELETE FROM product_margins WHERE listing_id=? AND revision=?").bind(listingId, expectedRevision).run();
    if (!result.meta || result.meta.changes !== 1) fail("MARGIN_CHANGED", "Il margine è cambiato in un’altra sessione. Ricarica la pagina.", 409);
    return { ok: true, removed: true, listing_id: listingId };
  }

  const minimum = marginValue(body.minimum, "Margine minimo");
  const target = marginValue(body.target, "Margine obiettivo");
  if (Number(minimum.replace(",", ".")) > Number(target.replace(",", "."))) {
    fail("INVALID_MARGIN_RANGE", "Il margine minimo non può superare il margine obiettivo");
  }
  const sku = String(body.sku || "Non disponibile").trim().slice(0, 500) || "Non disponibile";
  const now = new Date().toISOString();
  const operation = crypto.randomUUID();
  const write = expectedRevision === 0
    ? env.PURCHASES_DB.prepare(`INSERT INTO product_margins (listing_id,sku_snapshot,minimum_margin,target_margin,revision,updated_at,operation_id)
        VALUES (?,?,?,?,1,?,?) ON CONFLICT(listing_id) DO NOTHING`).bind(listingId, sku, minimum, target, now, operation)
    : env.PURCHASES_DB.prepare(`UPDATE product_margins SET sku_snapshot=?,minimum_margin=?,target_margin=?,revision=revision+1,
        updated_at=?,operation_id=? WHERE listing_id=? AND revision=?`).bind(sku, minimum, target, now, operation, listingId, expectedRevision);
  await write.run();
  const saved = await env.PURCHASES_DB.prepare(`SELECT listing_id,sku_snapshot,minimum_margin,target_margin,revision,updated_at,operation_id
    FROM product_margins WHERE listing_id=?`).bind(listingId).first();
  if (!saved || saved.operation_id !== operation) fail("MARGIN_CHANGED", "Il margine è cambiato in un’altra sessione. Ricarica la pagina.", 409);
  delete saved.operation_id;
  return { ok: true, margin: saved };
}

export async function settingsRoute(request, url, env) {
  const path = url.pathname;
  if (request.method === "GET" || request.method === "HEAD") {
    if (path === "/api/settings") return readEconomicSettings(env);
    if (path === "/api/settings/product-margins") return listProductMargins(env);
  }
  if (request.method === "POST") {
    const body = await settingsBody(request);
    if (path === "/api/settings") return saveEconomicSettings(body, env);
    if (path === "/api/settings/product-margin") return saveProductMargin(body, env);
  }
  fail("NOT_FOUND", "Endpoint impostazioni non trovato", 404);
}
