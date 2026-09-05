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

test("la Home gestisce l’unico accesso e le pagine protette vi ritornano", () => {
  const home = read("index.html");
  const auth = read("app-auth.js");
  const guard = read("app-auth-guard.js");
  assert.match(home, /Accedi al Centro operativo/);
  assert.match(home, /id="accessLogin"/);
  assert.match(home, /id="homeView"/);
  assert.match(auth, /\/api\/purchases\/status/);
  assert.match(auth, /sessionStorage\.setItem/);
  assert.match(guard, /index\.html\?return=/);
  for (const file of ["buybox.html","acquisti.html","abbinamenti.html","lavorazione.html","impostazioni.html","calcolo-completo.html","calcolo-light.html"]) {
    assert.match(read(file), /app-auth-guard\.js/, file);
  }
});

test("il Calcolatore Mobile usa profili online e Personalizzato solo in sessione", () => {
  const html = read("calcolo-light.html");
  const script = read("calcolo-light.js");
  assert.match(html, /data-profile="backmarket"/);
  assert.match(html, /data-profile="purchases"/);
  assert.match(html, /data-profile="refurbed"/);
  assert.match(html, /data-profile="custom"/);
  assert.match(html, /Non viene salvato online/);
  assert.match(html, /Mercati standard/);
  assert.match(html, /Mercati ridotti/);
  assert.match(html, /shared-settings\.js/);
  assert.match(html, /buybox-core\.js/);
  assert.doesNotMatch(html, /<style[\s>]/);
  assert.doesNotMatch(html, /<script>(?:.|\n)*<\/script>/);
  assert.doesNotMatch(html, /style=/);
  assert.match(script, /loadOnline/);
  assert.match(script, /resolveProfile/);
  assert.match(script, /suggestedPurchaseForMargin/);
  assert.match(script, /calculateMargin/);
  assert.match(script, /sessionStorage\.setItem/);
  assert.doesNotMatch(script, /settingsApi\.saveOnline/);
});

test("la Home sostituisce la verifica tecnica Drive con la lavorazione ordini", () => {
  const html = read("index.html");
  assert.match(html, /href="lavorazione\.html"/);
  assert.doesNotMatch(html, /href="verifica-drive\.html"/);
});

test("la Home e le pagine operative collegano le impostazioni online", () => {
  const home = read("index.html");
  const settings = read("impostazioni.html");
  const script = read("impostazioni.js");
  const buybox = read("buybox.js");
  assert.match(home, /href="impostazioni\.html"/);
  assert.match(settings, /Configurazione online/);
  assert.match(settings, /name="sekRate"/);
  assert.match(settings, /name="exchangeRateMode"/);
  assert.match(settings, /Aggiorna cambi ora/);
  assert.match(script, /saveOnline/);
  assert.match(script, /\/api\/settings\/rates\/refresh/);
  assert.match(script, /product-margins/);
  assert.match(buybox, /loadOnlinePreferences/);
  assert.match(buybox, /saveOnlineProductMargin/);
});

test("le Impostazioni separano i profili senza mostrare l’elenco dei margini articolo", () => {
  const html = read("impostazioni.html");
  const script = read("impostazioni.js");
  assert.match(html, /data-settings-tab="general"/);
  assert.match(html, /data-settings-tab="backmarket"/);
  assert.match(html, /data-settings-tab="purchases"/);
  assert.match(html, /data-settings-tab="refurbed"/);
  assert.match(html, /name="purchaseImportPerDevice"/);
  assert.match(html, /name="purchaseShippingPerDevice"/);
  assert.match(html, /BackMarket \+ <b id="purchaseCostSummary">9,00 €<\/b>/);
  assert.doesNotMatch(script, /data-margin-row/);
  assert.match(script, /resolveProfile|profiles\.purchases/);
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
  assert.match(script, /Quantità magazzino/);
  assert.match(script, /Costo articolo/);
  assert.match(script, /work-table/);
  assert.match(read("buybox.js"), /\/api\/purchases\/costs/);
});

test("Acquisti filtra gli ordini per periodo e lavorazione", () => {
  const html = read("acquisti.html");
  const script = read("acquisti.js");
  assert.match(html, /id="historyFrom"/);
  assert.match(html, /id="historyTo"/);
  assert.match(html, /value="pending">Da evadere/);
  assert.match(html, /value="done">Evasi/);
  assert.match(script, /params\.set\("status",historyState\)/);
  assert.match(script, /Evaso/);
});

test("la Valutazione stock usa catalogo, profilo Acquisti e sole letture BuyBox", () => {
  const html = read("calcolo-completo.html");
  const script = read("calcolo-completo.js");
  assert.match(html, /href="index\.html"[^>]*>← Home/);
  assert.match(html, /Valutazione stock BackMarket/);
  assert.match(html, /data-mode="uniform"/);
  assert.match(html, /data-mode="mixed"/);
  assert.match(html, /data-mode="uncertain"/);
  assert.match(html, /<script src="shared-settings\.js(?:\?v=[^"]+)?"><\/script>/);
  assert.match(html, /stock-valuation-core\.js/);
  assert.match(script, /resolveProfile\(state\.settings,"purchases"\)/);
  assert.match(script, /\/api\/catalog/);
  assert.match(script, /\/api\/backbox\//);
  assert.doesNotMatch(script, /\/api\/listings\//);
  assert.doesNotMatch(script, /method\s*:\s*["']POST["']/);
  assert.doesNotMatch(html, /style=/);
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
  const publicFiles = ["index.html", "app-auth.js", "app-auth-guard.js", "calcolo-completo.html", "calcolo-light.html", "calcolo-light.js", "buybox.html", "buybox.js", "buybox-config.js"];
  for (const file of publicFiles) {
    const content = read(file);
    assert.doesNotMatch(content, /BACKMARKET_TOKEN\s*[:=]\s*["'][^"']+/i, file);
    assert.doesNotMatch(content, /Authorization\s*:\s*["']Basic\s+[^$]/i, file);
  }
});
