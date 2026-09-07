import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { buyboxCaptureRoute } from "../src/buybox-capture.js";

class D1Test {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0006_buybox_capture.sql", import.meta.url), "utf8"));
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
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

const MARKETS = ["IT", "AT", "BE", "ES", "FR", "FI", "GR", "IE", "NL", "PT", "SE", "SK"];
const url = path => new URL("https://worker.test" + path);
const get = path => new Request("https://worker.test" + path);
const post = (path, payload) => new Request("https://worker.test" + path, { method: "POST", body: JSON.stringify(payload) });

function setup(t) {
  const database = new D1Test(); t.after(() => database.db.close());
  const prices = Object.fromEntries(MARKETS.map(market => [market, { price: market === "SE" ? "19000.00" : "1850.00", min: market === "SE" ? "18500.00" : "1800.00", max: market === "SE" ? "50000.00" : "5000.00" }]));
  let quantity = 0;
  const writes = [];
  const operations = {
    async loadListing(_id, market) { const row = prices[market]; return { id: "listing-pilot", product_id: "17942454-4c3f-4ae4-997f-42d8c057e638", sku: "Apple iPhone 17 Pro Max 2000GB - Arancione Cosmico PREMIUM", title: "iPhone 17 Pro Max", quantity, price: row.price, min_price: row.min, max_price: row.max, currency: market === "SE" ? "SEK" : "EUR" }; },
    async updatePrice(_id, market, price, minimum) { writes.push({ type: "price", market, price, minimum }); prices[market].price = price; prices[market].min = minimum; },
    async updateQuantity(_id, value) { writes.push({ type: "quantity", value }); quantity = value; },
    async loadBackbox() { return [
      { market: "FR", is_winning: false, winner_price: { amount: "1890.00", currency: "EUR" }, price_to_win: { amount: "1888.00", currency: "EUR" } },
      { market: "IT", is_winning: true, winner_price: { amount: "5000.00", currency: "EUR" }, price_to_win: null },
      { market: "BE", is_winning: false, winner_price: null, price_to_win: null },
    ]; },
  };
  return { database, env: { PURCHASES_DB: database }, operations, writes, getQuantity: () => quantity, prices };
}

test("prepara senza scrivere, attiva, salva solo concorrenza reale e ripristina", async t => {
  const state = setup(t);
  const prepared = await buyboxCaptureRoute(post("/api/buybox-captures/prepare", { listing_id: "listing-pilot", confirm: true }), url("/api/buybox-captures/prepare"), state.env, state.operations);
  assert.equal(prepared.markets.length, 12); assert.equal(prepared.backmarket_modified, false); assert.equal(state.writes.length, 0);

  const activated = await buyboxCaptureRoute(post("/api/buybox-captures/activate", { job_id: prepared.job_id, confirm: true }), url("/api/buybox-captures/activate"), state.env, state.operations);
  assert.equal(activated.status, "active"); assert.equal(state.getQuantity(), 1);
  assert.equal(state.prices.FR.price, "5000.00");

  const captured = await buyboxCaptureRoute(post("/api/buybox-captures/capture", { job_id: prepared.job_id, confirm: true }), url("/api/buybox-captures/capture"), state.env, state.operations);
  assert.equal(captured.status, "restored"); assert.equal(captured.competitive_markets, 1); assert.equal(state.getQuantity(), 0);
  assert.equal(state.prices.FR.price, "1850.00"); assert.equal(state.prices.FR.min, "1800.00");
  assert.equal(captured.observations.find(row => row.market === "IT").classification, "own_winning");
  assert.equal(captured.observations.find(row => row.market === "BE").classification, "invalid");

  const stock = await buyboxCaptureRoute(get("/api/buybox-captures/stock?listing_ids=listing-pilot"), url("/api/buybox-captures/stock?listing_ids=listing-pilot"), state.env, state.operations);
  assert.equal(stock.results["listing-pilot"].competitors.length, 1);
  assert.equal(stock.results["listing-pilot"].competitors[0].market, "FR");
  assert.equal(stock.results["listing-pilot"].competitors[0].source, "temporary_capture");
});

test("un errore durante l'attivazione forza quantità zero e ripristino prezzi", async t => {
  const state = setup(t);
  const prepared = await buyboxCaptureRoute(post("/api/buybox-captures/prepare", { listing_id: "listing-pilot", confirm: true }), url("/api/buybox-captures/prepare"), state.env, state.operations);
  const baseUpdate = state.operations.updatePrice; let failed = false;
  state.operations.updatePrice = async (...args) => { if (!failed && args[1] === "FR") { failed = true; throw new Error("upstream"); } return baseUpdate(...args); };
  await assert.rejects(() => buyboxCaptureRoute(post("/api/buybox-captures/activate", { job_id: prepared.job_id, confirm: true }), url("/api/buybox-captures/activate"), state.env, state.operations));
  assert.equal(state.getQuantity(), 0); assert.equal(state.prices.IT.price, "1850.00");
  const status = await buyboxCaptureRoute(get(`/api/buybox-captures/status?job_id=${prepared.job_id}`), url(`/api/buybox-captures/status?job_id=${prepared.job_id}`), state.env, state.operations);
  assert.equal(status.job.status, "restored");
});

test("una modifica esterna dopo la preparazione blocca tutto senza sovrascriverla", async t => {
  const state = setup(t);
  const prepared = await buyboxCaptureRoute(post("/api/buybox-captures/prepare", { listing_id: "listing-pilot", confirm: true }), url("/api/buybox-captures/prepare"), state.env, state.operations);
  state.prices.FR.price = "1840.00";
  await assert.rejects(() => buyboxCaptureRoute(post("/api/buybox-captures/activate", { job_id: prepared.job_id, confirm: true }), url("/api/buybox-captures/activate"), state.env, state.operations), { code: "LISTING_CHANGED" });
  assert.equal(state.prices.FR.price, "1840.00");
  assert.equal(state.writes.length, 0);
  const status = await buyboxCaptureRoute(get(`/api/buybox-captures/status?job_id=${prepared.job_id}`), url(`/api/buybox-captures/status?job_id=${prepared.job_id}`), state.env, state.operations);
  assert.equal(status.job.status, "restored");
});

test("rifiuta inserzioni che hanno già quantità", async t => {
  const state = setup(t); state.operations.loadListing = async () => ({ id: "listing-pilot", product_id: "product-pilot", sku: "SKU", quantity: 2, price: "10", min_price: "9", max_price: "20", currency: "EUR" });
  await assert.rejects(() => buyboxCaptureRoute(post("/api/buybox-captures/prepare", { listing_id: "listing-pilot", confirm: true }), url("/api/buybox-captures/prepare"), state.env, state.operations), { code: "LISTING_HAS_STOCK" });
});

test("annullare una sola preparazione non scrive su Back Market", async t => {
  const state = setup(t);
  const prepared = await buyboxCaptureRoute(post("/api/buybox-captures/prepare", { listing_id: "listing-pilot", confirm: true }), url("/api/buybox-captures/prepare"), state.env, state.operations);
  const restored = await buyboxCaptureRoute(post("/api/buybox-captures/restore", { job_id: prepared.job_id, confirm: true }), url("/api/buybox-captures/restore"), state.env, state.operations);
  assert.equal(restored.backmarket_modified, false);
  assert.equal(state.writes.length, 0);
});
