import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, settingsRoute } from "../src/settings.js";
import { handleRequest } from "../src/index.js";

class D1Test {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0003_online_settings.sql", import.meta.url), "utf8"));
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
