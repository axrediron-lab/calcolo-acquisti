import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { cancellationRoute, processQuantityOrderItem, workQuantityOrder } from "../src/cancellations.js";
import { purchaseRoute } from "../src/purchases.js";

class D1Test {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    for (const name of ["0001_purchases.sql", "0002_purchase_processing.sql", "0005_client_cancellations.sql"]) this.db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
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

function setup(t) {
  const database = new D1Test();
  t.after(() => database.db.close());
  return { database, env: { PURCHASES_DB: database, APP_ACCESS_KEY: "test-access-key" } };
}

const post = (path, payload) => new Request("https://worker.test" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
const get = path => new Request("https://worker.test" + path);
const url = path => new URL("https://worker.test" + path);

function ordersPage() {
  return {
    next: null,
    results: [
      { order_id: 101, date_modification: "2099-09-06T12:00:00.000Z", orderlines: [
        { id: 1001, state: 4, listing_id: "listing-1001", listing: "iPhone 15 128GB Nero Eccellente", product: "Apple iPhone 15 128GB", quantity: 1 },
        { id: 1002, state: 5, listing_id: "listing-1002", listing: "Escluso Merchant", product: "Escluso", quantity: 4 },
      ] },
      { order_id: 102, date_modification: "2099-09-06T12:05:00.000Z", orderlines: [
        { id: 1003, state: 4, listing_id: "listing-1001", listing: "iPhone 15 128GB Nero Eccellente", product: "Apple iPhone 15 128GB", quantity: 2 },
      ] },
    ],
  };
}

test("l'attivazione fissa la baseline senza leggere o modificare Back Market", async t => {
  const { database, env } = setup(t);
  let calls = 0;
  const operations = { fetchOrdersPage: async () => { calls += 1; return ordersPage(); } };
  const result = await cancellationRoute(post("/api/cancellations/activate", { confirm: true }), url("/api/cancellations/activate"), env, operations);
  assert.equal(result.activated_now, true);
  assert.equal(result.historical_rows_imported, false);
  assert.equal(calls, 0);
  assert.equal(database.db.prepare("SELECT count(*) n FROM client_cancellations").get().n, 0);
});

test("la sincronizzazione salva solo stato 4, esclude stato 5 e non scrive su Back Market", async t => {
  const { database, env } = setup(t);
  let updates = 0;
  const operations = { fetchOrdersPage: async () => ordersPage(), updateQuantity: async () => { updates += 1; } };
  await cancellationRoute(post("/api/cancellations/activate", { confirm: true }), url("/api/cancellations/activate"), env, operations);
  const result = await cancellationRoute(post("/api/cancellations/sync", {}), url("/api/cancellations/sync"), env, operations);
  assert.equal(result.state_4_read, 2);
  assert.equal(result.valid_rows_seen, 2);
  assert.equal(updates, 0);
  assert.deepEqual(database.db.prepare("SELECT orderline_id,processing_status FROM client_cancellations ORDER BY orderline_id").all().map(row => ({ ...row })), [
    { orderline_id: 1001, processing_status: "pending" },
    { orderline_id: 1003, processing_status: "pending" },
  ]);
  await cancellationRoute(post("/api/cancellations/sync", {}), url("/api/cancellations/sync"), env, operations);
  assert.equal(database.db.prepare("SELECT count(*) n FROM client_cancellations").get().n, 2);
});

test("raggruppa lo stesso SKU, usa orderline_id una volta e crea un ordine senza costi", async t => {
  const { database, env } = setup(t);
  const operations = { fetchOrdersPage: async () => ordersPage() };
  await cancellationRoute(post("/api/cancellations/activate", { confirm: true }), url("/api/cancellations/activate"), env, operations);
  await cancellationRoute(post("/api/cancellations/sync", {}), url("/api/cancellations/sync"), env, operations);
  const created = await cancellationRoute(post("/api/cancellations/restore", { orderline_ids: [1001, 1003], confirm: true }), url("/api/cancellations/restore"), env, operations);
  assert.equal(created.line_count, 1);
  assert.equal(created.units, 3);
  assert.equal(created.backmarket_modified, false);
  assert.equal(created.prices_modified, false);
  assert.equal(database.db.prepare("SELECT quantity FROM quantity_order_lines").get().quantity, 3);
  assert.equal(database.db.prepare("SELECT count(*) n FROM product_costs").get().n, 0);
  await assert.rejects(() => cancellationRoute(post("/api/cancellations/restore", { orderline_ids: [1001], confirm: true }), url("/api/cancellations/restore"), env, operations), { code: "SELECTION_CHANGED" });
  const work = await workQuantityOrder(created.order_key, env);
  assert.equal(work.document.document_type, "quantity_only");
  assert.equal(work.items[0].incoming_quantity, 3);
});

test("l'ordine quantity_only compare in Acquisti e la modalità manuale non invia quantità", async t => {
  const { database, env } = setup(t);
  const operations = { fetchOrdersPage: async () => ordersPage() };
  await cancellationRoute(post("/api/cancellations/activate", { confirm: true }), url("/api/cancellations/activate"), env, operations);
  await cancellationRoute(post("/api/cancellations/sync", {}), url("/api/cancellations/sync"), env, operations);
  const created = await cancellationRoute(post("/api/cancellations/restore", { orderline_ids: [1001, 1003], confirm: true }), url("/api/cancellations/restore"), env, operations);
  const history = await purchaseRoute(get("/api/purchases/documents?status=pending"), url("/api/purchases/documents?status=pending"), env, {});
  assert.equal(history.results[0].document_type, "quantity_only");
  assert.equal(history.results[0].total_cents, null);
  let updates = 0;
  const processed = await processQuantityOrderItem({ document_key: created.order_key, listing_id: "listing-1001", mode: "manual", expected_bm_quantity: 8, confirm: true }, env, {
    loadListing: async () => ({ id: "listing-1001", sku: "SKU", quantity: 8 }),
    updateQuantity: async () => { updates += 1; },
  });
  assert.equal(processed.quantity_status, "manual");
  assert.equal(processed.target_quantity, 8);
  assert.equal(updates, 0);
  assert.equal(database.db.prepare("SELECT count(*) n FROM product_costs").get().n, 0);
});

test("l'invio automatico somma una volta la quantità e il retry è idempotente", async t => {
  const { env } = setup(t);
  const operations = { fetchOrdersPage: async () => ordersPage() };
  await cancellationRoute(post("/api/cancellations/activate", { confirm: true }), url("/api/cancellations/activate"), env, operations);
  await cancellationRoute(post("/api/cancellations/sync", {}), url("/api/cancellations/sync"), env, operations);
  const created = await cancellationRoute(post("/api/cancellations/restore", { orderline_ids: [1001, 1003], confirm: true }), url("/api/cancellations/restore"), env, operations);
  let quantity = 8, writes = 0;
  const processing = { loadListing: async () => ({ id: "listing-1001", sku: "SKU", quantity }), updateQuantity: async (_id, target) => { writes += 1; quantity = target; } };
  const payload = { document_key: created.order_key, listing_id: "listing-1001", mode: "automatic", expected_bm_quantity: 8, confirm: true };
  const first = await processQuantityOrderItem(payload, env, processing);
  const retry = await processQuantityOrderItem(payload, env, processing);
  assert.equal(first.target_quantity, 11);
  assert.equal(quantity, 11);
  assert.equal(writes, 1);
  assert.equal(retry.duplicate, true);
});
