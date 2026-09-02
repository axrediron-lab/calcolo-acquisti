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
  sekRate: "0,090",
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
  assert.equal(core.toNumber("0.090"), 0.09);
  assert.equal(core.toNumber(""), 0);
});

test("applica la commissione corretta per Paese e converte la Svezia", () => {
  assert.equal(core.marketRule("IT").commission, 12);
  assert.equal(core.marketRule("AT").commission, 5);
  assert.equal(core.marketRule("SE").currency, "SEK");
  assert.ok(Math.abs(core.amountToEuro(1380, "SEK", settings) - 124.2) < 1e-9);
  assert.ok(Math.abs(core.amountFromEuro(124.2, "SEK", settings) - 1380) < 1e-9);
});

test("calcola minimo e target per mercato rispettando il limite BackPricer", () => {
  const italy = core.marketPricePlan(100, "IT", settings);
  const sweden = core.marketPricePlan(100, "SE", settings);
  assert.equal(italy.currency, "EUR");
  assert.equal(italy.minimum, 145.99);
  assert.equal(italy.target, 150.72);
  assert.equal(sweden.currency, "SEK");
  assert.ok(sweden.target >= sweden.minimum);
  assert.ok(sweden.target <= sweden.minimum * 1.08 + 1e-9);
});

test("applica margini personalizzati al singolo prodotto", () => {
  const plan = core.marketPricePlan(100, "IT", settings, { minimum: "8", target: "10" });
  const minimumResult = core.calculateMargin(plan.minimum, 100, 0.12, settings);
  const targetResult = core.calculateMargin(plan.target, 100, 0.12, settings);
  assert.ok(minimumResult.margin >= 0.08);
  assert.ok(targetResult.margin >= 0.10);
});

test("calcola l'acquisto consigliato dalla media delle due BackBox", () => {
  const averageBackbox = (334 + 305) / 2;
  const suggested = core.suggestedPurchaseForMargin(averageBackbox, 0.12, 0.075, settings);
  assert.ok(Math.abs(suggested - 230.4735) < 1e-9);
});

test("riconosce la batteria 100% dal testo della listing", () => {
  const listing = core.normalizeListing({
    id: "listing-battery-100",
    title: "Apple iPhone 14 128GB - Mezzanotte",
    sku: "Apple iPhone 14 128GB - Mezzanotte Eccellente 100%",
    grade: "EXCELLENT",
    new_battery: false,
  });
  assert.equal(listing.battery100, true);
  assert.equal(listing.batteryLabel, "Batteria 100%");
});
