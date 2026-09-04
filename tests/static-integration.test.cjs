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

test("la Home sostituisce la verifica tecnica Drive con la lavorazione ordini", () => {
  const html = read("index.html");
  assert.match(html, /href="lavorazione\.html"/);
  assert.doesNotMatch(html, /href="verifica-drive\.html"/);
});

test("la lavorazione separa costo, quantità e prezzi con conferma esplicita", () => {
  const html = read("lavorazione.html");
  const script = read("lavorazione.js");
  assert.match(html, /Nessuna modifica senza conferma/);
  assert.match(script, /prices_only/);
  assert.match(script, /manual/);
  assert.match(script, /automatic/);
  assert.match(script, /confirm\(/);
  assert.match(script, /Prezzi e BuyBox/);
  assert.match(read("buybox.js"), /\/api\/purchases\/costs/);
});

test("il Calcolo completo include Home e impostazioni condivise", () => {
  const html = read("calcolo-completo.html");
  assert.match(html, /href="index\.html"[^>]*>← Home/);
  assert.match(html, /id="minimumMargin"/);
  assert.match(html, /id="shippingItaly"/);
  assert.match(html, /<script src="shared-settings\.js"><\/script>/);
});

test("la pagina BuyBox usa dati API e protegge gli aggiornamenti", () => {
  const html = read("buybox.html");
  const script = read("buybox.js");
  const coreScript = read("buybox-core.js");
  const css = read("styles.css");
  assert.match(html, /write-enabled-badge/);
  assert.match(html, /id="batteryFilter"/);
  assert.doesNotMatch(html, /Catalogo, BuyBox, prezzi e quantità Back Market raggruppati/);
  assert.match(script, /\/api\/catalog/);
  assert.match(script, /data-open-detail/);
  assert.match(script, /productDetailHtml/);
  assert.match(script, /detail-controls-grid/);
  assert.match(script, /searchParams\.set\("listing"/);
  assert.match(script, /popstate/);
  assert.match(script, /bulk-send-header/);
  assert.match(script, /backbox-pill/);
  assert.match(script, /listing\.quantity/);
  assert.match(script, /Vinte/);
  assert.match(script, /Prezzo minimo/);
  assert.match(script, /Prezzo target/);
  assert.match(script, /BB att\./);
  assert.match(script, /BB da battere/);
  assert.match(script, /Acq\. cons\./);
  assert.match(script, /data-margin-field/);
  assert.match(script, /data-price-result/);
  assert.match(script, /price-result-slot/);
  assert.match(script, /suggestedPurchaseForMargin/);
  assert.match(script, /sendQuantity/);
  assert.match(script, /sendAllMarketPrices/);
  assert.match(script, /quantityB-quantityA/);
  assert.match(script, /buyboxCurrency/);
  assert.match(script, /shippingItaly/);
  assert.match(script, /listing\.simType/);
  assert.match(script, /batteryLabel === battery/);
  assert.match(script, /core\.matchesSearch/);
  assert.match(script, /initializeCustomSelects/);
  assert.match(script, /filter-dropdown-option/);
  assert.match(script, /draft\.sending = true/);
  assert.match(script, /if\(askConfirmation\) renderCatalog\(\)/);
  assert.match(script, /controlStackHtml/);
  assert.match(script, /purchase-note/);
  assert.match(script, /refreshReactivatedBuybox/);
  assert.match(script, /\?refresh=1/);
  assert.match(script, /Promise\.all\(\[runQueue\(\)/);
  assert.match(coreScript, /P-SIM/);
  assert.match(coreScript, /E-SIM/);
  assert.doesNotMatch(script, /Bozza calcolata/);
  assert.doesNotMatch(script, /Per vincere:/);
  assert.doesNotMatch(script, /commission-chip/);
  assert.doesNotMatch(script, /market-detail-row/);
  assert.doesNotMatch(script, /<section class="detail-economics"/);
  assert.doesNotMatch(script, /<th>Economia<\/th>/);
  assert.doesNotMatch(script, /<th>Invia<\/th>/);
  assert.doesNotMatch(script, /Prezzi per Paese/);
  assert.doesNotMatch(script, /class="market-panel-title"/);
  assert.match(css, /width:\s*min\(1840px,98vw\)/);
  assert.match(css, /\.product-detail-page \.market-panel\s*\{\s*width:\s*100%/);
  assert.match(css, /\.filter-dropdown-menu/);
  assert.match(css, /\.control-status/);
  assert.match(css, /\.purchase-box\.missing \.purchase-content/);
  assert.match(css, /\.detail-stock \.detail-label\s*\{\s*text-align:\s*center;?\s*\}/);
  assert.doesNotMatch(css, /width:\s*min\(100%,1600px\)/);
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
