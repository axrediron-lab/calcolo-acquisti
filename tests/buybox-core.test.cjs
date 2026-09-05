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
  shippingItaly: "7,50",
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
  assert.equal(listing.simType, "P-SIM");
  assert.equal(listing.currentPrice, 399.99);
  assert.equal(listing.quantity, 4);
});

test("gestisce numeri italiani e internazionali", () => {
  assert.equal(core.toNumber("€ 1.249,90"), 1249.9);
  assert.equal(core.toNumber("399.99"), 399.99);
  assert.equal(core.toNumber("0.090"), 0.09);
  assert.equal(core.toNumber(320.625), 320.625);
  assert.equal(core.amountFromEuro(320.625, "EUR", settings), 320.625);
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
  const belgium = core.marketPricePlan(100, "BE", settings);
  const sweden = core.marketPricePlan(100, "SE", settings);
  assert.equal(italy.currency, "EUR");
  assert.equal(italy.minimum, 135);
  assert.equal(italy.target, 139.5);
  assert.ok(belgium.minimum > italy.minimum);
  assert.equal(sweden.currency, "SEK");
  assert.ok(sweden.target >= sweden.minimum);
  assert.ok(sweden.target <= sweden.minimum * 1.08 + 1e-9);
  assert.equal(italy.minimum * 2, Math.round(italy.minimum * 2));
  assert.equal(italy.target * 2, Math.round(italy.target * 2));
});

test("arrotonda minimo e target per eccesso a scatti di 0,50", () => {
  const plan = core.marketPricePlan(241, "AT", settings, { minimum: "6", target: "7,50" });
  assert.equal(plan.minimum * 2, Math.round(plan.minimum * 2));
  assert.equal(plan.target * 2, Math.round(plan.target * 2));
  assert.ok(plan.target <= plan.minimum * 1.08 + 1e-9);
});

test("applica margini personalizzati al singolo prodotto", () => {
  const plan = core.marketPricePlan(100, "IT", settings, { minimum: "8", target: "10" });
  const minimumResult = core.calculateMargin(plan.minimum, 100, 0.12, settings, "IT");
  const targetResult = core.calculateMargin(plan.target, 100, 0.12, settings, "IT");
  assert.ok(minimumResult.margin >= 0.08);
  assert.ok(targetResult.margin >= 0.10);
});

test("usa la spedizione Italia da 7,50 euro solo per il mercato IT", () => {
  const italy = core.calculateMargin(200, 100, 0.12, settings, "IT");
  const austria = core.calculateMargin(200, 100, 0.05, settings, "AT");
  assert.equal(italy.fixedCosts, 7.5);
  assert.equal(austria.fixedCosts, 16.5);
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

test("riconosce E-SIM dallo SKU e usa P-SIM quando non è indicato", () => {
  const esim = core.normalizeListing({
    id: "listing-esim",
    title: "Apple iPhone 14 128GB - Mezzanotte",
    sku: "Apple iPhone 14 128GB - Mezzanotte E-SIM",
  });
  const physical = core.normalizeListing({
    id: "listing-physical",
    title: "Apple iPhone 14 128GB - Mezzanotte",
    sku: "Apple iPhone 14 128GB - Mezzanotte",
  });
  assert.equal(esim.simType, "E-SIM");
  assert.equal(esim.simKey, "esim_only");
  assert.equal(esim.simLabel, "Solo eSIM");
  assert.equal(physical.simType, "P-SIM");
  assert.equal(physical.simKey, "physical_esim");
  assert.equal(physical.simLabel, "SIM fisica + eSIM");
  assert.notEqual(esim.familyKey, physical.familyKey);
});

test("separa Dual SIM fisica e blocca una configurazione SIM contraddittoria", () => {
  const dual = core.normalizeListing({
    id: "listing-dual",
    title: "Samsung Galaxy S24 256GB - Nero",
    sku: "Samsung Galaxy S24 256GB Nero Dual SIM",
  });
  const ambiguous = core.normalizeListing({
    id: "listing-ambiguous",
    title: "Samsung Galaxy S24 256GB - Nero",
    sku: "Samsung Galaxy S24 256GB Dual SIM eSIM",
  });
  assert.equal(dual.simKey, "dual_physical");
  assert.equal(dual.simLabel, "Dual SIM fisica");
  assert.equal(dual.eligibleForAggregation, true);
  assert.equal(ambiguous.simKey, "unknown");
  assert.equal(ambiguous.eligibleForAggregation, false);
  assert.deepEqual(ambiguous.classificationIssues, ["Configurazione SIM ambigua"]);
});

test("unifica gli alias CN 100% ed Eccellente batteria 100%", () => {
  const aliases = ["CN 100%", "Eccellente 100%", "Eccellente batteria 100%"].map((alias, index) => core.normalizeListing({
    id: `listing-alias-${index}`,
    title: "Apple iPhone 15 128GB - Nero",
    sku: `Apple iPhone 15 128GB Nero ${alias}`,
    grade: "EXCELLENT",
  }));
  aliases.forEach((listing) => {
    assert.equal(listing.quality, "Eccellente");
    assert.equal(listing.batteryKey, "100");
    assert.equal(listing.batteryLabel, "Batteria 100%");
    assert.equal(listing.qualityAlias, "Eccellente · Batteria 100%");
    assert.equal(listing.eligibleForAggregation, true);
  });
  assert.equal(new Set(aliases.map((listing) => listing.variantKey)).size, 1);
});

test("esclude dalla media un alias 100% incompatibile con il grado", () => {
  const listing = core.normalizeListing({
    id: "listing-conflict",
    title: "Apple iPhone 15 128GB - Nero",
    sku: "Apple iPhone 15 128GB Nero CN 100%",
    grade: "GOOD",
  });
  assert.equal(listing.quality, "Buono");
  assert.equal(listing.eligibleForAggregation, false);
  assert.deepEqual(listing.classificationIssues, ["Grado incompatibile con alias Eccellente 100%"]);
});

test("trova un prodotto usando parole separate e in ordine diverso", () => {
  const listing = core.normalizeListing({
    id: "listing-search",
    title: "Apple iPhone 15 128GB - Blu",
    sku: "Apple iPhone 15 128GB Blu CN 100%",
    grade: "EXCELLENT",
  });
  assert.equal(core.matchesSearch(listing, "iPhone 15 128 blu"), true);
  assert.equal(core.matchesSearch(listing, "blu eccellente 128"), true);
  assert.equal(core.matchesSearch(listing, "iphone 256 blu"), false);
});
