const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../buybox-core.js");

const settings = {
  fee12: "12",
  fee5: "5",
  investorFee: "1",
  storfundFee: "1,20",
  paymentFee: "1",
  importFee: "0",
  shipping: "16,50",
  minimumMargin: "5",
  targetMargin: "7,50",
};

test("calcola il margine netto includendo tutte le fee e i costi fissi", () => {
  const result = core.calculateMargin(400, 280, 0.12, settings);
  assert.equal(result.variableCosts, 60.8);
  assert.equal(result.fixedCosts, 16.5);
  assert.ok(Math.abs(result.profit - 42.7) < 1e-9);
  assert.ok(Math.abs(result.margin - 0.10675) < 1e-9);
});

test("calcola prezzo di acquisto suggerito e prezzo vendita da margine netto", () => {
  const suggestedPurchase = core.suggestedPurchase(400, 0.12, settings);
  const salePrice = core.salePriceForMargin(280, 0.12, 0.10, settings);
  assert.ok(Math.abs(suggestedPurchase - 292.7) < 1e-9);
  assert.ok(Math.abs(salePrice - 396.3903743315508) < 1e-9);
});

test("una modifica alle fee condivise aggiorna automaticamente il risultato", () => {
  const current = core.calculateMargin(400, 280, 0.12, settings);
  const changed = core.calculateMargin(400, 280, 0.12, {
    ...settings,
    investorFee: "0",
    shipping: "10",
  });
  assert.ok(changed.profit > current.profit);
  assert.ok(changed.margin > current.margin);
});

test("normalizza modello, capacità, colore, grado e batteria dalla listing", () => {
  const listing = core.normalizeListing({
    id: "listing-123",
    product_id: "product-456",
    sku: "APL-IP14-128-MID-EX",
    title: "Apple iPhone 14 128GB - Mezzanotte",
    grade: "EXCELLENT",
    new_battery: true,
    price: "399,99",
    min_price: "360",
    max_price: "430",
    quantity: 4,
  });

  assert.equal(listing.family, "Apple iPhone 14");
  assert.equal(listing.brand, "Apple");
  assert.equal(listing.capacity, "128 GB");
  assert.equal(listing.color, "Mezzanotte");
  assert.equal(listing.quality, "Eccellente");
  assert.equal(listing.batteryLabel, "Batteria nuova");
  assert.equal(listing.currentPrice, 399.99);
  assert.equal(listing.quantity, 4);
});

test("gestisce numeri italiani e internazionali", () => {
  assert.equal(core.toNumber("€ 1.249,90"), 1249.9);
  assert.equal(core.toNumber("399.99"), 399.99);
  assert.equal(core.toNumber(""), 0);
});
