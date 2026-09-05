const MAX_BODY_BYTES = 16 * 1024;
const ECONOMIC_KEY = "economic";
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v2/rate";

const ECONOMIC_DEFAULTS = Object.freeze({
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
  exchangeRateMode: "automatic",
});

export const DEFAULT_PROFILES = Object.freeze({
  backmarket: Object.freeze({ label: "BackMarket", configured: true }),
  purchases: Object.freeze({ label: "Acquisti", configured: true, base: "backmarket", importPerDevice: "7", shippingPerDevice: "2" }),
  refurbed: Object.freeze({ label: "Refurbed", configured: false }),
});

export const DEFAULT_SETTINGS = Object.freeze({ ...ECONOMIC_DEFAULTS, profiles: DEFAULT_PROFILES });

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
  for (const key of Object.keys(ECONOMIC_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) fail("MISSING_SETTING", "Completa tutte le impostazioni");
    if (key === "exchangeRateMode") {
      if (!["automatic", "manual"].includes(input[key])) fail("INVALID_RATE_MODE", "Modalità dei cambi non valida");
      output[key] = input[key];
    } else if (PERCENT_KEYS.has(key)) output[key] = numberValue(input[key], key, { maximum: 100 });
    else if (AMOUNT_KEYS.has(key)) output[key] = numberValue(input[key], key);
    else if (RATE_KEYS.has(key)) output[key] = numberValue(input[key], key, { allowZero: false });
  }
  if (Number(output.minimumMargin.replace(",", ".")) > Number(output.targetMargin.replace(",", "."))) {
    fail("INVALID_MARGIN_RANGE", "Il margine minimo non può superare il margine obiettivo");
  }
  output.profiles = validateProfiles(input.profiles);
  return output;
}

function profileAmount(value, fallback, label) {
  return numberValue(value === undefined || value === null ? fallback : value, label);
}

function validateProfiles(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const purchases = source.purchases && typeof source.purchases === "object" && !Array.isArray(source.purchases) ? source.purchases : {};
  const refurbed = source.refurbed && typeof source.refurbed === "object" && !Array.isArray(source.refurbed) ? source.refurbed : {};
  return {
    backmarket: { ...DEFAULT_PROFILES.backmarket },
    purchases: {
      ...DEFAULT_PROFILES.purchases,
      importPerDevice: profileAmount(purchases.importPerDevice, DEFAULT_PROFILES.purchases.importPerDevice, "Importazione Acquisti"),
      shippingPerDevice: profileAmount(purchases.shippingPerDevice, DEFAULT_PROFILES.purchases.shippingPerDevice, "Spedizione Acquisti"),
    },
    refurbed: {
      ...DEFAULT_PROFILES.refurbed,
      configured: refurbed.configured === true,
    },
  };
}

function parseStoredSettings(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return validateSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return validateSettings(DEFAULT_SETTINGS);
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
    settings: validateSettings(DEFAULT_SETTINGS),
    revision: 0,
    updated_at: null,
  };
}

function rateStatusFromRow(row, mode) {
  return {
    mode,
    status: row?.status || "never",
    provider: row?.provider || "ECB via Frankfurter",
    reference_date: row?.reference_date || null,
    last_attempt_at: row?.last_attempt_at || null,
    last_success_at: row?.last_success_at || null,
    error: row?.last_error || null,
  };
}

async function readRateStatus(env, mode) {
  const row = await env.PURCHASES_DB.prepare(`SELECT provider,reference_date,last_attempt_at,last_success_at,status,last_error
    FROM exchange_rate_status WHERE status_key='ecb'`).first();
  return rateStatusFromRow(row, mode);
}

function normalizedRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1000) {
    fail("INVALID_EXCHANGE_RATE", "Il servizio cambi ha restituito un valore non valido", 502);
  }
  return numeric.toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

async function frankfurterRate(currency, fetcher) {
  const response = await fetcher(`${FRANKFURTER_BASE}/${currency}/EUR?providers=ECB`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) fail("EXCHANGE_RATE_UNAVAILABLE", "Il servizio cambi non è disponibile", 502);
  let payload;
  try { payload = await response.json(); } catch { fail("INVALID_EXCHANGE_RATE", "Il servizio cambi ha restituito dati non validi", 502); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("INVALID_EXCHANGE_RATE", "Il servizio cambi ha restituito dati non validi", 502);
  }
  const date = String(payload.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("INVALID_EXCHANGE_RATE", "La data del cambio non è valida", 502);
  return { rate: normalizedRate(payload.rate), date };
}

async function recordRateFailure(env, now, error) {
  const message = error instanceof SettingsError ? error.publicMessage : "Il servizio cambi non è disponibile";
  await env.PURCHASES_DB.prepare(`INSERT INTO exchange_rate_status
    (status_key,provider,reference_date,last_attempt_at,last_success_at,status,last_error)
    VALUES ('ecb','ECB via Frankfurter',NULL,?,NULL,'error',?)
    ON CONFLICT(status_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status='error',last_error=excluded.last_error`)
    .bind(now, message).run();
}

async function writeAutomaticRates(env, usdRate, sekRate, referenceDate, now) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readEconomicSettings(env);
    if (current.settings.exchangeRateMode === "manual") {
      return { ok: true, skipped: true, reason: "manual", ...current, exchange_rates: await readRateStatus(env, "manual") };
    }
    const settings = validateSettings({ ...current.settings, usdRate, sekRate });
    const operation = crypto.randomUUID();
    const values = JSON.stringify(settings);
    const write = current.exists
      ? env.PURCHASES_DB.prepare(`UPDATE app_settings SET values_json=?,revision=revision+1,updated_at=?,operation_id=?
          WHERE settings_key=? AND revision=?`).bind(values, now, operation, ECONOMIC_KEY, current.revision)
      : env.PURCHASES_DB.prepare(`INSERT INTO app_settings (settings_key,values_json,revision,updated_at,operation_id)
          VALUES (?,?,1,?,?) ON CONFLICT(settings_key) DO NOTHING`).bind(ECONOMIC_KEY, values, now, operation);
    await env.PURCHASES_DB.batch([
      write,
      env.PURCHASES_DB.prepare(`INSERT INTO app_settings_history (settings_key,values_json,revision,changed_at)
        SELECT settings_key,values_json,revision,updated_at FROM app_settings WHERE settings_key=? AND operation_id=?
        ON CONFLICT(settings_key,revision) DO NOTHING`).bind(ECONOMIC_KEY, operation),
      env.PURCHASES_DB.prepare(`INSERT INTO exchange_rate_status
        (status_key,provider,reference_date,last_attempt_at,last_success_at,status,last_error)
        VALUES ('ecb','ECB via Frankfurter',?,?,?,'ok',NULL)
        ON CONFLICT(status_key) DO UPDATE SET provider=excluded.provider,reference_date=excluded.reference_date,
        last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,status='ok',last_error=NULL`)
        .bind(referenceDate, now, now),
    ]);
    const saved = await env.PURCHASES_DB.prepare("SELECT values_json,revision,updated_at,operation_id FROM app_settings WHERE settings_key=?")
      .bind(ECONOMIC_KEY).first();
    if (saved?.operation_id === operation) {
      return {
        ok: true,
        exists: true,
        settings: parseStoredSettings(saved.values_json),
        revision: saved.revision,
        updated_at: saved.updated_at,
        exchange_rates: await readRateStatus(env, "automatic"),
      };
    }
  }
  fail("SETTINGS_CHANGED", "Le impostazioni sono cambiate durante l’aggiornamento dei cambi. Riprova.", 409);
}

export async function refreshExchangeRates(env, fetcher = fetch) {
  const now = new Date().toISOString();
  const current = await readEconomicSettings(env);
  if (current.settings.exchangeRateMode === "manual") {
    return { ok: true, skipped: true, reason: "manual", ...current, exchange_rates: await readRateStatus(env, "manual") };
  }
  try {
    const [usd, sek] = await Promise.all([frankfurterRate("USD", fetcher), frankfurterRate("SEK", fetcher)]);
    if (usd.date !== sek.date) fail("EXCHANGE_RATE_DATE_MISMATCH", "Le date dei cambi USD e SEK non coincidono", 502);
    return await writeAutomaticRates(env, usd.rate, sek.rate, usd.date, now);
  } catch (error) {
    await recordRateFailure(env, now, error);
    throw error;
  }
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
    if (path === "/api/settings") {
      const result = await readEconomicSettings(env);
      return { ...result, exchange_rates: await readRateStatus(env, result.settings.exchangeRateMode) };
    }
    if (path === "/api/settings/product-margins") return listProductMargins(env);
  }
  if (request.method === "POST") {
    const body = await settingsBody(request);
    if (path === "/api/settings") return saveEconomicSettings(body, env);
    if (path === "/api/settings/rates/refresh") {
      if (body.confirm !== true) fail("CONFIRM_REQUIRED", "Conferma l’aggiornamento dei cambi");
      return refreshExchangeRates(env);
    }
    if (path === "/api/settings/product-margin") return saveProductMargin(body, env);
  }
  fail("NOT_FOUND", "Endpoint impostazioni non trovato", 404);
}
