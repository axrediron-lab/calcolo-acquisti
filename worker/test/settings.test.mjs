import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, refreshExchangeRates, settingsRoute } from "../src/settings.js";
import { handleRequest } from "../src/index.js";

class D1Test {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0003_online_settings.sql", import.meta.url), "utf8"));
    this.db.exec(readFileSync(new URL("../migrations/0004_exchange_rate_status.sql", import.meta.url), "utf8"));
  }
  prepare(sql) {
    const database = this.db;
    const statement = (params = []) => ({
      bind: (...values) => statement(values),
      async all() { return { results: database.prepare(sql).all(...params), success: true }; },
      async first() { return database.prepare(sql).get(...params) || null; },
      async run() { const result = database.prepare(sql).run(...params); return { success: true, meta: { changes: result.changes } }; },
    });
    return statement();
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function setup(t) {
  const database = new D1Test();
  t.after(() => database.db.close());
  return { database, env: { PURCHASES_DB: database, APP_ACCESS_KEY: "test-secret-not-real", ALLOWED_ORIGINS: "https://test.local" } };
}

function request(path, body) {
  return new Request("https://test.local" + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("le impostazioni iniziali vengono lette senza creare dati", async t => {
  const { env, database } = setup(t);
  const url = new URL("https://test.local/api/settings");
  const result = await settingsRoute(request("/api/settings"), url, env);
  assert.equal(result.exists, false);
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.equal(database.db.prepare("SELECT count(*) count FROM app_settings").get().count, 0);
});

test("aggiunge i profili predefiniti anche alle impostazioni nel formato precedente", async t => {
  const { env } = setup(t);
  const legacy = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => key !== "profiles"));
  const saved = await settingsRoute(
    request("/api/settings", { settings: legacy, expected_revision: 0, confirm: true }),
    new URL("https://test.local/api/settings"),
    env,
  );
  assert.equal(saved.settings.profiles.backmarket.configured, true);
  assert.equal(saved.settings.profiles.purchases.base, "backmarket");
  assert.equal(saved.settings.profiles.purchases.importPerDevice, "7");
  assert.equal(saved.settings.profiles.purchases.shippingPerDevice, "2");
  assert.equal(saved.settings.profiles.refurbed.configured, false);
});

test("salva online le impostazioni con revisione e storico", async t => {
  const { env, database } = setup(t);
  const url = new URL("https://test.local/api/settings");
  const values = { ...DEFAULT_SETTINGS, sekRate: "0,091", shippingItaly: "8,00" };
  const saved = await settingsRoute(request("/api/settings", { settings: values, expected_revision: 0, confirm: true }), url, env);
  assert.equal(saved.revision, 1);
  assert.equal(saved.settings.sekRate, "0,091");
  assert.equal(database.db.prepare("SELECT count(*) count FROM app_settings_history").get().count, 1);
  await assert.rejects(() => settingsRoute(request("/api/settings", { settings: values, expected_revision: 0, confirm: true }), url, env), { code: "SETTINGS_CHANGED" });
  const updated = await settingsRoute(request("/api/settings", { settings: { ...values, fee12: "13" }, expected_revision: 1, confirm: true }), url, env);
  assert.equal(updated.revision, 2);
  assert.equal(database.db.prepare("SELECT count(*) count FROM app_settings_history").get().count, 2);
});

test("rifiuta configurazioni incomplete o margini generali incoerenti", async t => {
  const { env } = setup(t);
  const url = new URL("https://test.local/api/settings");
  await assert.rejects(() => settingsRoute(request("/api/settings", { settings: { fee12: "12" }, expected_revision: 0, confirm: true }), url, env), { code: "MISSING_SETTING" });
  await assert.rejects(() => settingsRoute(request("/api/settings", { settings: { ...DEFAULT_SETTINGS, minimumMargin: "9", targetMargin: "7" }, expected_revision: 0, confirm: true }), url, env), { code: "INVALID_MARGIN_RANGE" });
});

test("salva, elenca e rimuove i margini personalizzati online", async t => {
  const { env } = setup(t);
  const saveUrl = new URL("https://test.local/api/settings/product-margin");
  const listUrl = new URL("https://test.local/api/settings/product-margins");
  const saved = await settingsRoute(request("/api/settings/product-margin", { listing_id: "listing-123", sku: "SKU-123", minimum: "6,5", target: "9", expected_revision: 0, confirm: true }), saveUrl, env);
  assert.equal(saved.margin.revision, 1);
  const updated = await settingsRoute(request("/api/settings/product-margin", { listing_id: "listing-123", sku: "SKU-123", minimum: "7", target: "10", expected_revision: 1, confirm: true }), saveUrl, env);
  assert.equal(updated.margin.revision, 2);
  assert.equal(updated.margin.target_margin, "10");
  await assert.rejects(() => settingsRoute(request("/api/settings/product-margin", { listing_id: "listing-123", sku: "SKU-123", minimum: "7", target: "11", expected_revision: 1, confirm: true }), saveUrl, env), { code: "MARGIN_CHANGED" });
  assert.equal((await settingsRoute(request("/api/settings/product-margins"), listUrl, env)).results.length, 1);
  await settingsRoute(request("/api/settings/product-margin", { listing_id: "listing-123", expected_revision: 2, remove: true, confirm: true }), saveUrl, env);
  assert.equal((await settingsRoute(request("/api/settings/product-margins"), listUrl, env)).results.length, 0);
});

test("API impostazioni protetta senza dipendere dalle credenziali Back Market", async t => {
  const { env } = setup(t);
  const denied = await handleRequest(new Request("https://test.local/api/settings"), env);
  assert.equal(denied.status, 401);
  const allowed = await handleRequest(new Request("https://test.local/api/settings", { headers: { "X-App-Key": env.APP_ACCESS_KEY } }), env);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).exists, false);
});

test("aggiorna automaticamente USD ed SEK dalla BCE e salva fonte e data", async t => {
  const { env, database } = setup(t);
  const calls = [];
  const fetcher = async url => {
    calls.push(String(url));
    const isUsd = String(url).includes("/USD/EUR");
    return new Response(JSON.stringify({ date: "2026-09-04", base: isUsd ? "USD" : "SEK", quote: "EUR", rate: isUsd ? 0.861234 : 0.091234 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const result = await refreshExchangeRates(env, fetcher);
  assert.equal(result.settings.usdRate, "0,861234");
  assert.equal(result.settings.sekRate, "0,091234");
  assert.equal(result.exchange_rates.status, "ok");
  assert.equal(result.exchange_rates.reference_date, "2026-09-04");
  assert.equal(result.exchange_rates.provider, "ECB via Frankfurter");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.includes("providers=ECB")));
  assert.equal(database.db.prepare("SELECT count(*) count FROM app_settings_history").get().count, 1);
});

test("mantiene l'ultimo cambio valido quando Frankfurter non risponde", async t => {
  const { env } = setup(t);
  await refreshExchangeRates(env, async url => new Response(JSON.stringify({
    date: "2026-09-04",
    rate: String(url).includes("/USD/EUR") ? 0.86 : 0.09,
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(() => refreshExchangeRates(env, async () => new Response("", { status: 503 })), { code: "EXCHANGE_RATE_UNAVAILABLE" });
  const result = await settingsRoute(request("/api/settings"), new URL("https://test.local/api/settings"), env);
  assert.equal(result.settings.usdRate, "0,86");
  assert.equal(result.settings.sekRate, "0,09");
  assert.equal(result.exchange_rates.status, "error");
  assert.equal(result.exchange_rates.reference_date, "2026-09-04");
});

test("la modalità manuale impedisce la sostituzione automatica dei cambi", async t => {
  const { env } = setup(t);
  const manual = { ...DEFAULT_SETTINGS, exchangeRateMode: "manual", usdRate: "0,95", sekRate: "0,095" };
  await settingsRoute(request("/api/settings", { settings: manual, expected_revision: 0, confirm: true }), new URL("https://test.local/api/settings"), env);
  let calls = 0;
  const result = await refreshExchangeRates(env, async () => { calls += 1; return new Response("{}"); });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "manual");
  assert.equal(result.settings.usdRate, "0,95");
  assert.equal(calls, 0);
});
