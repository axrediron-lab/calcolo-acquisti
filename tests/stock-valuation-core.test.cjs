const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../buybox-core.js");
const valuation = require("../stock-valuation-core.js");
const settingsApi = require("../shared-settings.js");

const settings = settingsApi.resolveProfile(settingsApi.defaults(), "purchases");

function listing(id, color, quality = "EXCELLENT", skuSuffix = "") {
  return core.normalizeListing({
    id,
    title: `Apple iPhone 15 128GB - ${color}`,
    sku: `Apple iPhone 15 128GB ${color} ${skuSuffix}`,
    grade: quality,
    currency: "EUR",
  });
}

function competitor(market, price, currency = "EUR", field = "price_to_win") {
  return { market, [field]: { amount: String(price), currency } };
}

test("raggruppa i colori ma separa configurazioni SIM", () => {
  const black = listing("black", "Nero");
  const blue = listing("blue", "Blu");
  const esim = listing("esim", "Nero", "EXCELLENT", "E-SIM");
  const groups = valuation.groupFamilies([black, blue, esim]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.listings.length).sort(), [1, 2]);
  assert.notEqual(black.familyKey, esim.familyKey);
});

test("usa la mediana dei colori e preferisce price_to_win", () => {
  const rows = [listing("a", "Nero"), listing("b", "Blu"), listing("c", "Verde")];
  const payloads = {
    a: { competitors: [competitor("FR", 400)] },
    b: { competitors: [competitor("FR", 410)] },
    c: { competitors: [competitor("FR", 900), competitor("IT", 390, "EUR", "winner_price")] },
  };
  const benchmarks = valuation.buildVariantBenchmarks(rows, payloads, settings);
  const variant = benchmarks[rows[0].variantKey];
  assert.equal(variant.markets.FR.value, 410);
  assert.equal(variant.markets.FR.colors, 3);
  assert.equal(variant.markets.FR.priceToWin, 3);
  assert.equal(variant.markets.IT.value, 390);
});

test("calcola il mix noto con pesi e non trasforma i mancanti in zero", () => {
  const excellent = listing("excellent", "Nero", "EXCELLENT");
  const good = listing("good", "Nero", "GOOD");
  const benchmarks = valuation.buildVariantBenchmarks([excellent, good], {
    excellent: { competitors: [competitor("FR", 400), competitor("AT", 420)] },
    good: { competitors: [competitor("FR", 300)] },
  }, settings);
  const composed = valuation.weightedMarkets(benchmarks, [
    { variantKey: excellent.variantKey, weight: 30 },
    { variantKey: good.variantKey, weight: 70 },
  ]);
  assert.equal(composed.markets.FR.value, 330);
  assert.equal(composed.markets.FR.coverage, 1);
  assert.equal(composed.markets.AT.value, 420);
  assert.equal(composed.markets.AT.coverage, 0.3);
});

test("lo scenario incerto produce prudente, centrale e favorevole", () => {
  const variants = {
    low: { markets: { FR: { value: 300, colors: 2 } } },
    mid: { markets: { FR: { value: 400, colors: 2 } } },
    high: { markets: { FR: { value: 500, colors: 2 } } },
  };
  assert.equal(valuation.uncertainMarkets(variants, ["low", "mid", "high"], "conservative").markets.FR.value, 300);
  assert.equal(valuation.uncertainMarkets(variants, ["low", "mid", "high"], "central").markets.FR.value, 400);
  assert.equal(valuation.uncertainMarkets(variants, ["low", "mid", "high"], "favorable").markets.FR.value, 500);
});

test("valuta margine reale e acquisto massimo col profilo Acquisti", () => {
  const composed = { markets: { FR: { value: 400, coverage: 1, colors: 3, variants: 1 } } };
  const result = valuation.evaluateGroup(composed, ["FR"], 280, 10, 0.075, settings);
  assert.equal(result.markets, 1);
  assert.equal(result.totalProfit, result.profit * 10);
  assert.ok(result.maximumPurchase < 300);
  assert.equal(result.rows[0].market, "FR");
});
