(function () {
  "use strict";
  var config = window.BUYBOX_CONFIG;
  var mode = document.body.dataset.mode;
  var byId = id => document.getElementById(id);
  var docs = [], catalog = null, currentMapping = null, sourceRequest = null, offset = null, historyRows = [], busy = false;
  var memoryKey = "", historyQuery = "", historyFrom = "", historyTo = "", historyState = "pending";
  try { memoryKey = sessionStorage.getItem(config.accessSessionKey) || ""; } catch (_) {}
  var money = cents => (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
  var esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function message(text) { byId("purchaseStatus").textContent = text; }
  function loginState() {
    var dialog = byId("purchaseLoginDialog");
    byId("purchaseWorkspace").hidden = !memoryKey;
    if (memoryKey) { if (dialog.open) dialog.close(); }
    else if (!dialog.open) { dialog.showModal(); setTimeout(() => byId("purchaseKey").focus(), 0); }
  }
  function logout() {
    memoryKey = ""; try { sessionStorage.removeItem(config.accessSessionKey); } catch (_) {}
    docs = []; catalog = null; currentMapping = null; sourceRequest = null; historyRows = [];
    byId("purchaseHistory").replaceChildren(); byId("documentContent").replaceChildren();
    if (byId("purchasePreview")) byId("purchasePreview").replaceChildren();
    if (byId("previewSource")) byId("previewSource").textContent = "";
    if (byId("purchaseFile")) byId("purchaseFile").value = "";
    byId("mappingDialog").close(); byId("documentDialog").close(); loginState();
  }
  async function api(path, body) {
    var controller = new AbortController();
    var timer = setTimeout(() => controller.abort(), 75000);
    try {
      var response = await fetch(config.apiBase + path, { method: body === undefined ? "GET" : "POST",
        headers: { "X-App-Key": memoryKey, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
      var data = await response.json();
      if (response.status === 401) { logout(); throw new Error("Accesso scaduto o codice errato. Inserisci il codice BuyBox attuale."); }
      if (!response.ok) throw new Error(data.error || "Operazione non riuscita");
      return data;
    } catch (error) {
      if (error.name === "AbortError" || error instanceof TypeError) throw new Error("Connessione interrotta. Se stavi salvando, verifica lo storico prima di riprovare: il documento potrebbe essere già registrato.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function run(fn) {
    if (busy) return;
    busy = true; document.body.classList.add("is-working");
    try { await fn(); } catch (error) { message(error.message || "Operazione non riuscita"); }
    finally { busy = false; document.body.classList.remove("is-working"); }
  }
  function linesTable(lines, editable) {
    return '<div class="purchases-table-wrap"><table><thead><tr><th>Codice Ready</th><th>Descrizione</th><th>Quantità ricevuta</th><th>Costo unitario EUR</th><th>SKU Back Market</th><th>Azioni</th></tr></thead><tbody>' + lines.map(l => '<tr><td>' + esc(l.ready_code) + '<small>Riga file ' + esc(l.source_row) + '</small></td><td>' + esc(l.description) + '</td><td>' + esc(l.quantity) + '</td><td>' + esc(money(l.unit_cost_cents)) + '</td><td>' + esc(l.mapping?.sku || "Da abbinare") + '</td><td>' + (editable ? '<button type="button" data-map="' + esc(l.ready_code) + '">' + (l.mapping ? "Modifica" : "Abbina") + '</button>' : '') + (l.mapping ? '<a href="buybox.html?listing=' + encodeURIComponent(l.mapping.listing_id) + '">BuyBox →</a>' : '') + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function references(refs) { return refs.length ? refs.map(r => esc(r.text)).join(" · ") : "Nessun riferimento d’origine nel file"; }
  function renderPreview() {
    byId("purchasePreview").innerHTML = docs.map((d, index) => {
      var status = { new: d.missing ? d.missing + " righe da abbinare" : "Pronto per il salvataggio", duplicate: "Già salvato — nessun doppio carico", conflict: "Contenuto diverso da quello già salvato — bloccato" }[d.status];
      return '<details class="purchases-panel" open><summary>Documento ' + esc(d.number) + ' · ' + esc(d.date) + ' · ' + d.units + ' pezzi · ' + esc(money(d.total_cents)) + '</summary><p>' + references(d.references) + '</p><p class="document-state">' + esc(status) + '</p>' + linesTable(d.lines, d.status === "new") + '<button type="button" data-confirm="' + index + '" ' + (!d.token ? 'disabled' : '') + '>Salva documento nell’archivio</button><small>Non aggiorna le quantità su Back Market.</small></details>';
    }).join('');
  }
  async function loadPreview() {
    docs = []; byId("purchasePreview").replaceChildren(); message("Lettura e controllo documenti…");
    var data = await api("/api/purchases/preview", sourceRequest);
    docs = data.documents; byId("previewSource").textContent = "Origine: " + data.source.name + " · " + docs.length + " documenti. L’anteprima non è ancora salvata.";
    renderPreview();
    var missing = new Set(docs.filter(d => d.status === "new").flatMap(d => d.lines.filter(l => !l.mapping).map(l => l.ready_code)));
    message(missing.size ? "Completa gli abbinamenti richiesti: " + missing.size + " codici Ready non ancora associati." : "Controllo completato. Verifica i documenti prima di salvarli.");
  }
  async function history(append) {
    var path = mode === "mappings" ? "/api/mappings" : "/api/purchases/documents";
    if (!append) {
      historyQuery = byId("historyQuery").value;
      if (mode === "purchases") {
        historyFrom = byId("historyFrom").value;
        historyTo = byId("historyTo").value;
        historyState = byId("historyState").value;
      }
    }
    var params = new URLSearchParams({ q:historyQuery, offset:String(append ? offset : 0) });
    if (mode === "purchases") { params.set("from",historyFrom); params.set("to",historyTo); params.set("status",historyState); }
    var data = await api(path + "?" + params.toString());
    historyRows = append ? historyRows.concat(data.results) : data.results;
    offset = data.next_offset; byId("historyMore").hidden = offset === null;
    if (!historyRows.length) { byId("purchaseHistory").textContent = "Nessun risultato."; return; }
    if (mode === "mappings") {
      byId("purchaseHistory").innerHTML = '<div class="purchases-table-wrap"><table><thead><tr><th>Codice Ready</th><th>Descrizione Ready</th><th>SKU Back Market</th><th>Ultima modifica</th><th>Azioni</th></tr></thead><tbody>' + historyRows.map(m => '<tr><td>' + esc(m.ready_code) + '</td><td>' + esc(m.ready_description) + '</td><td>' + esc(m.sku || "Rimosso — da abbinare alla prossima importazione") + '</td><td>' + esc(new Date(m.updated_at).toLocaleString("it-IT")) + '</td><td><button type="button" data-map="' + esc(m.ready_code) + '">Modifica</button>' + (m.listing_id ? '<button type="button" data-remove="' + esc(m.ready_code) + '" class="secondary">Rimuovi</button>' : '') + '<button type="button" data-audit="' + esc(m.ready_code) + '" class="secondary">Storico</button></td></tr>').join('') + '</tbody></table></div>';
    } else {
      byId("purchaseHistory").innerHTML = '<div class="purchases-table-wrap"><table><thead><tr><th>Documento Ready</th><th>Data</th><th>Righe</th><th>Pezzi</th><th>Costo totale EUR</th><th>Stato</th><th>Azioni</th></tr></thead><tbody>' + historyRows.map(d => { var complete=d.processed_items>=d.item_count&&!d.pending_items,state=complete?'Evaso':d.processed_items?'In lavorazione':'Da evadere'; return '<tr><td><strong>' + esc(d.document_number) + '</strong></td><td>' + esc(d.document_date) + '</td><td>' + d.row_count + '</td><td>' + d.units + '</td><td>' + esc(money(d.total_cents)) + '</td><td><span class="order-state '+(complete?'done':'pending')+'">' + esc(state) + '</span></td><td><a class="table-action" href="lavorazione.html?key=' + encodeURIComponent(d.document_key) + '">'+(complete?'Rivedi':'Lavora')+'</a><button type="button" data-document="' + esc(d.document_key) + '">Apri</button></td></tr>'; }).join('') + '</tbody></table></div>';
    }
  }
  function filterListings() {
    var q = byId("listingSearch").value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    var matches = (catalog || []).filter(l => q.every(w => (l.sku + " " + (l.title || l.product?.title || "")).toLowerCase().includes(w)));
    var select = byId("listingChoice"); select.replaceChildren();
    matches.slice(0, 50).forEach(l => { var option = document.createElement("option"); option.value = String(l.id); option.textContent = l.sku; select.appendChild(option); });
    select.selectedIndex = -1;
    byId("listingCount").textContent = matches.length > 50 ? "Primi 50 risultati su " + matches.length + ". Rendi la ricerca più precisa." : matches.length + " risultati. Seleziona manualmente lo SKU.";
  }
  async function openMapping(code) {
    var m;
    if (mode === "mappings") m = historyRows.find(r => r.ready_code === code);
    else {
      var line = docs.filter(d => d.status === "new").flatMap(d => d.lines).find(l => l.ready_code === code);
      if (line) m = { ready_code: code, ready_description: line.description, revision: line.mapping_revision, sku: line.mapping?.sku, listing_id: line.mapping?.listing_id };
    }
    if (!m) return;
    currentMapping = m; message("Caricamento del catalogo Back Market per scegliere lo SKU…");
    if (!catalog) { var data = await api("/api/catalog"); catalog = data.results.filter(l => l.id && typeof l.sku === "string"); }
    byId("mappingContext").textContent = m.ready_code + " — " + m.ready_description;
    byId("mappingCurrent").textContent = "Abbinamento attuale: " + (m.sku || "nessuno");
    byId("mappingError").textContent = ""; byId("listingSearch").value = ""; filterListings(); byId("mappingDialog").showModal();
    message("Seleziona lo SKU esatto e conferma l’abbinamento.");
  }
  byId("purchaseLogin").addEventListener("submit", event => { event.preventDefault(); run(async () => {
    memoryKey = byId("purchaseKey").value.trim(); byId("purchaseKey").value = "";
    byId("purchaseLoginError").hidden = true;
    try { await api("/api/purchases/status"); } catch (error) { logout(); byId("purchaseLoginError").textContent = error.message; byId("purchaseLoginError").hidden = false; throw error; }
    try { sessionStorage.setItem(config.accessSessionKey, memoryKey); } catch (_) {}
    loginState(); await history(false); message("Archivio online disponibile.");
  }); });
  byId("purchaseLogout").addEventListener("click", () => { if (!busy) { logout(); message("Disconnesso."); } });
  byId("historySearch").addEventListener("submit", event => { event.preventDefault(); run(() => history(false)); });
  if (mode === "purchases") byId("historyReset").addEventListener("click", () => {
    byId("historyQuery").value = ""; byId("historyFrom").value = ""; byId("historyTo").value = ""; byId("historyState").value = "pending";
    run(() => history(false));
  });
  byId("historyMore").addEventListener("click", () => run(() => history(true)));
  byId("listingSearch").addEventListener("input", filterListings);
  byId("mappingCancel").addEventListener("click", () => { if (!busy) byId("mappingDialog").close(); });
  byId("documentClose").addEventListener("click", () => byId("documentDialog").close());
  byId("mappingForm").addEventListener("submit", event => { event.preventDefault(); run(async () => {
    var listingId = byId("listingChoice").value; if (!listingId || !currentMapping) return;
    var selected = catalog.find(l => String(l.id) === listingId);
    if (!confirm("Confermi " + currentMapping.ready_code + " → " + selected.sku + "?\nVale solo per nuove importazioni. Nessun dato storico sarà spostato.")) return;
    try {
      await api("/api/mappings/save", { ready_code: currentMapping.ready_code, ready_description: currentMapping.ready_description, expected_revision: currentMapping.revision, listing_id: listingId, confirm: true });
    } catch (error) { byId("mappingError").textContent = error.message; throw error; }
    byId("mappingDialog").close();
    if (mode === "purchases") await loadPreview(); else { await history(false); message("Abbinamento salvato online. Nessun documento precedente modificato."); }
  }); });
  document.addEventListener("click", event => {
    var target = event.target.closest("button"); if (!target) return;
    if (target.dataset.map) run(() => openMapping(target.dataset.map));
    if (target.dataset.confirm !== undefined) run(async () => {
      var doc = docs[Number(target.dataset.confirm)]; if (!doc?.token) return;
      if (!confirm("Salvare il documento " + doc.number + " del " + doc.date + "?\n" + doc.units + " pezzi, " + money(doc.total_cents) + ".\nLe quantità su Back Market NON saranno aggiornate.")) return;
      var saved = await api("/api/purchases/confirm", { token: doc.token, confirm: true });
      doc.status = "duplicate"; doc.token = null; renderPreview(); await history(false);
      message(saved.duplicate ? "Documento già salvato: nessun duplicato creato." : "Documento salvato online. Quantità e prezzi Back Market invariati.");
    });
    if (target.dataset.document) run(async () => {
      var d = await api("/api/purchases/document?key=" + encodeURIComponent(target.dataset.document));
      byId("documentTitle").textContent = "Documento " + d.document_number + " · " + d.document_date;
      byId("documentContent").innerHTML = '<p>' + references(d.references) + '</p><p>' + esc(d.source.name) + ' · ' + d.units + ' pezzi · ' + esc(money(d.total_cents)) + '</p><p>Abbinamenti storici al momento del salvataggio. Quantità non inviate a Back Market.</p>' + linesTable(d.lines, false);
      byId("documentDialog").showModal();
    });
    if (target.dataset.remove) run(async () => {
      var m = historyRows.find(r => r.ready_code === target.dataset.remove);
      if (!confirm("Rimuovere l’abbinamento futuro " + m.ready_code + " → " + m.sku + "?\nNessun documento, costo o quantità sarà modificato.")) return;
      await api("/api/mappings/save", { ready_code: m.ready_code, ready_description: m.ready_description, expected_revision: m.revision, remove: true, confirm: true });
      await history(false); message("Associazione rimossa per le nuove importazioni. Storico invariato.");
    });
    if (target.dataset.audit) run(async () => {
      var data = await api("/api/mappings/history?code=" + encodeURIComponent(target.dataset.audit));
      byId("documentTitle").textContent = "Storico abbinamenti · " + target.dataset.audit;
      byId("documentContent").innerHTML = '<p>Ultime 100 revisioni, dalla più recente.</p><ul>' + data.results.map(m => '<li>' + esc(new Date(m.changed_at).toLocaleString("it-IT")) + ' · revisione ' + m.revision + ' · ' + esc(m.sku || "Abbinamento rimosso") + '</li>').join('') + '</ul>';
      byId("documentDialog").showModal();
    });
  });
  if (mode === "purchases") {
    byId("readDrive").addEventListener("click", () => run(async () => { sourceRequest = { source: "drive" }; await loadPreview(); }));
    byId("purchaseFile").addEventListener("change", event => run(async () => {
      var file = event.target.files[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) throw new Error("Il file supera 2 MiB.");
      var bytes = await file.arrayBuffer(); var csv;
      try { csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (_) { csv = new TextDecoder("windows-1252").decode(bytes); }
      sourceRequest = { source: "upload", name: file.name, csv }; await loadPreview();
    }));
  }
  loginState(); if (memoryKey) run(async () => { await api("/api/purchases/status"); await history(false); message("Archivio online disponibile."); });
}());
