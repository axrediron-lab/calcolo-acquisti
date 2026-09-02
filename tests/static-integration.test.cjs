const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("la Home collega il Monitor BuyBox", () => {
  const html = read("index.html");
  assert.match(html, /href="buybox\.html"/);
  assert.match(html, /Monitor BuyBox/);
});

test("il Calcolo completo include Home e impostazioni condivise", () => {
  const html = read("calcolo-completo.html");
  assert.match(html, /href="index\.html"[^>]*>← Home/);
  assert.match(html, /id="minimumMargin"/);
  assert.match(html, /<script src="shared-settings\.js"><\/script>/);
});

test("la pagina BuyBox usa dati API e protegge gli aggiornamenti", () => {
  const html = read("buybox.html");
  const script = read("buybox.js");
  assert.match(html, /write-enabled-badge/);
  assert.match(script, /\/api\/catalog/);
  assert.match(script, /data-market-toggle/);
  assert.match(script, /Prezzi per Paese/);
  assert.match(script, /listing\.quantity/);
  assert.match(script, /Vinte/);
  assert.match(script, /Prezzo minimo/);
  assert.match(script, /Prezzo target/);
  assert.match(script, /sendQuantity/);
  assert.match(script, /sendAllMarketPrices/);
  assert.match(script, /quantityB-quantityA/);
  assert.match(script, /buyboxCurrency/);
  assert.doesNotMatch(script, /mock|demoListings|sampleProducts/i);
});

test("nessuna credenziale Back Market è incorporata nei file pubblici", () => {
  const publicFiles = ["index.html", "calcolo-completo.html", "buybox.html", "buybox.js", "buybox-config.js"];
  for (const file of publicFiles) {
    const content = read(file);
    assert.doesNotMatch(content, /BACKMARKET_TOKEN\s*[:=]\s*["'][^"']+/i, file);
    assert.doesNotMatch(content, /Authorization\s*:\s*["']Basic\s+[^$]/i, file);
  }
});
