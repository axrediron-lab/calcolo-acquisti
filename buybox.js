(function(){
  "use strict";

  var config = window.BUYBOX_CONFIG;
  var core = window.BuyboxCore;
  var settingsApi = window.CalcoloSettings;
  var state = {
    listings:[],
    settings:settingsApi.load(),
    purchases:readJson(config.purchaseCacheKey) || {},
    buyboxes:{},
    openFamilies:{},
    openListings:{},
    loadingFamilies:{},
    updatedAt:null,
    source:"live"
  };

  function byId(id){ return document.getElementById(id); }
  function escapeHtml(value){
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }
  function readJson(key){
    try{ var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch(error){ return null; }
  }
  function writeJson(key,value){ try{ localStorage.setItem(key,JSON.stringify(value)); }catch(error){} }
  function sleep(ms){ return new Promise(function(resolve){ setTimeout(resolve,ms); }); }
  function accessKey(){ try{ return sessionStorage.getItem(config.accessSessionKey) || ""; }catch(error){ return ""; } }
  function setAccessKey(value){ try{ sessionStorage.setItem(config.accessSessionKey,value); }catch(error){} }
  function clearAccessKey(){ try{ sessionStorage.removeItem(config.accessSessionKey); }catch(error){} }

  function apiUrl(path){ return config.apiBase.replace(/\/$/,"") + path; }
  async function apiFetch(path, options){
    options = options || {};
    var headers = new Headers(options.headers || {});
    if(options.protected !== false && accessKey()){ headers.set("X-App-Key",accessKey()); }
    headers.set("Accept","application/json");
    var response = await fetch(apiUrl(path), {method:"GET",headers:headers,cache:"no-store"});
    var payload = null;
    try{ payload = await response.json(); }catch(error){}
    if(response.status === 401){
      clearAccessKey();
      var unauthorized = new Error("ACCESS_REQUIRED");
      unauthorized.code = "ACCESS_REQUIRED";
      throw unauthorized;
    }
    if(!response.ok){
      var message = payload && payload.error ? payload.error : "Servizio non disponibile";
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function renderSettings(){
    var settings = core.numericSettings(state.settings);
    var chips = [
      "BM 12%: " + (settings.fee12*100).toFixed(2).replace(".",",") + "%",
      "BM 5%: " + (settings.fee5*100).toFixed(2).replace(".",",") + "%",
      "Fee extra: " + ((settings.investorFee+settings.storfundFee+settings.paymentFee)*100).toFixed(2).replace(".",",") + "%",
      "Costi fissi: " + core.formatMoney(settings.shipping+settings.importFee),
      "Margine minimo: " + (settings.minimumMargin*100).toFixed(2).replace(".",",") + "%",
      "Margine obiettivo: " + (settings.targetMargin*100).toFixed(2).replace(".",",") + "%"
    ];
    byId("settingsSummary").innerHTML = chips.map(function(label){
      return '<span class="setting-chip">'+escapeHtml(label)+'</span>';
    }).join("");
  }

  function uniqueValues(key){
    return Array.from(new Set(state.listings.map(function(item){ return item[key]; }).filter(Boolean)))
      .sort(function(a,b){ return String(a).localeCompare(String(b),"it",{numeric:true}); });
  }
  function fillSelect(id,key,allLabel){
    var select = byId(id);
    var previous = select.value;
    select.innerHTML = '<option value="">'+escapeHtml(allLabel)+'</option>' + uniqueValues(key).map(function(value){
      return '<option value="'+escapeHtml(value)+'">'+escapeHtml(value)+'</option>';
    }).join("");
    if(Array.from(select.options).some(function(option){ return option.value === previous; })){ select.value = previous; }
  }
  function renderFilters(){
    fillSelect("brandFilter","brand","Tutte");
    fillSelect("capacityFilter","capacity","Tutte");
    fillSelect("colorFilter","color","Tutti");
    fillSelect("qualityFilter","quality","Tutte");
  }

  function filteredListings(){
    var query = byId("searchInput").value.trim().toLocaleLowerCase("it-IT");
    var brand = byId("brandFilter").value;
    var capacity = byId("capacityFilter").value;
    var color = byId("colorFilter").value;
    var quality = byId("qualityFilter").value;
    return state.listings.filter(function(item){
      return (!query || core.searchableText(item).indexOf(query) >= 0) &&
        (!brand || item.brand === brand) && (!capacity || item.capacity === capacity) &&
        (!color || item.color === color) && (!quality || item.quality === quality);
    });
  }

  function groupListings(listings){
    var groups = new Map();
    listings.forEach(function(item){
      var key = item.family || item.title;
      if(!groups.has(key)){ groups.set(key,[]); }
      groups.get(key).push(item);
    });
    return Array.from(groups.entries()).sort(function(a,b){ return a[0].localeCompare(b[0],"it",{numeric:true}); });
  }

  function marginClass(value){
    var settings = core.numericSettings(state.settings);
    if(value < settings.minimumMargin) return "bad";
    if(value < settings.targetMargin) return "warn";
    return "ok";
  }
  function competitorsFromEntry(entry){
    if(!entry || entry.loading || entry.error) return [];
    if(Array.isArray(entry.competitors)) return entry.competitors;
    if(Array.isArray(entry)) return entry;
    if(entry.competitor) return [entry.competitor];
    return [];
  }
  function competitorForMarket(entry,market){
    var target = String(market || config.market || "IT").toUpperCase();
    return competitorsFromEntry(entry).find(function(competitor){
      return String(competitor && competitor.market || "").toUpperCase() === target;
    }) || null;
  }
  function displayEntryForListing(listing){
    var direct = state.buyboxes[listing.id];
    if(competitorsFromEntry(direct).length || (direct && direct.loading)){
      return {entry:direct,isReference:false,source:null};
    }
    if(listing.quantity <= 0 && listing.productId){
      var source = state.listings.find(function(candidate){
        return candidate.id !== listing.id && candidate.productId === listing.productId &&
          candidate.quality === listing.quality && competitorsFromEntry(state.buyboxes[candidate.id]).length;
      });
      if(source){
        return {entry:state.buyboxes[source.id],isReference:true,source:source};
      }
    }
    return {entry:direct,isReference:false,source:null};
  }
  function buyboxAmount(competitor,field){
    var value = competitor && competitor[field];
    return value && value.amount !== undefined ? core.toNumber(value.amount) : value !== undefined && value !== null ? core.toNumber(value) : null;
  }
  function buyboxCurrency(competitor,field,fallback){
    var value = competitor && competitor[field];
    return String(value && value.currency ? value.currency : fallback || "EUR").toUpperCase();
  }
  function buyboxMoney(competitor,field,fallbackCurrency){
    var amount = buyboxAmount(competitor,field);
    return amount ? core.formatMoney(amount,buyboxCurrency(competitor,field,fallbackCurrency)) : "—";
  }
  function listingEconomics(listing,feeKey,competitor){
    competitor = competitor || competitorForMarket(displayEntryForListing(listing).entry,config.market);
    var backbox = buyboxAmount(competitor,"winner_price");
    if(buyboxCurrency(competitor,"winner_price",listing.currency) !== "EUR") return null;
    var purchase = core.toNumber(state.purchases[listing.id]);
    if(!backbox || !purchase) return null;
    var numeric = core.numericSettings(state.settings);
    return core.calculateMargin(backbox,purchase,numeric[feeKey],state.settings);
  }

  function marginHtml(result){
    if(!result) return '<span class="loading-cell">—</span>';
    return '<span class="margin-pill '+marginClass(result.margin)+'">'+
      escapeHtml(core.formatMoney(result.profit))+'<small>'+escapeHtml(core.formatPercent(result.margin))+'</small></span>';
  }

  function winLossHtml(listing){
    var view = displayEntryForListing(listing);
    var entry = view.entry;
    if(!entry) return '<span class="loading-cell">Apri la famiglia</span>';
    if(entry.loading) return '<span class="loading-cell">…</span>';
    if(view.isReference) return '<span class="reference-chip" title="Dati da una variante equivalente">Rif.</span>';
    if(entry.error) return '<span class="error-cell">—</span>';
    var competitors = competitorsFromEntry(entry);
    if(!competitors.length) return '<span class="loading-cell">—</span>';
    var wins = competitors.filter(function(item){ return item && item.is_winning === true; }).length;
    var losses = competitors.filter(function(item){ return item && item.is_winning === false; }).length;
    return '<span class="win-count" title="BuyBox vinte">'+wins+'</span><span class="loss-count" title="BuyBox perse">'+losses+'</span>';
  }

  function suggestedHtml(listing,competitor){
    competitor = competitor || competitorForMarket(displayEntryForListing(listing).entry,config.market);
    var winner = buyboxAmount(competitor,"winner_price");
    if(!winner) return "—";
    if(buyboxCurrency(competitor,"winner_price",listing.currency) !== "EUR") return "Cambio richiesto";
    var suggested = core.suggestedPurchase(winner,core.numericSettings(state.settings).fee12,state.settings);
    return core.formatMoney(suggested,listing.currency);
  }

  var MARKET_NAMES = {
    AT:"Austria", BE:"Belgio", DE:"Germania", ES:"Spagna", FI:"Finlandia",
    FR:"Francia", GR:"Grecia", IE:"Irlanda", IT:"Italia", NL:"Paesi Bassi",
    PT:"Portogallo", SE:"Svezia", SK:"Slovacchia"
  };

  function marketLabel(code){
    var market = String(code || "—").toUpperCase();
    return (MARKET_NAMES[market] || market) + (market === "—" ? "" : " · " + market);
  }

  function marketRowsHtml(listing){
    var view = displayEntryForListing(listing);
    var entry = view.entry;
    if(!entry || entry.loading) return '<div class="market-empty">Caricamento dei mercati…</div>';
    if(entry.error) return '<div class="market-empty error-cell">'+escapeHtml(entry.error)+'</div>';
    var competitors = competitorsFromEntry(entry).slice().sort(function(a,b){
      var marketA = String(a && a.market || "");
      var marketB = String(b && b.market || "");
      if(marketA === config.market) return -1;
      if(marketB === config.market) return 1;
      return marketA.localeCompare(marketB,"it");
    });
    if(!competitors.length) return '<div class="market-empty">Nessuna BuyBox disponibile per questa inserzione.</div>';
    var referenceText = view.isReference && view.source ? '<em>Riferimento: '+escapeHtml(view.source.sku || view.source.title)+'</em>' : '';
    return '<div class="market-panel'+(view.isReference?' reference':'')+'"><div class="market-panel-title">BuyBox per paese <span>'+competitors.length+' mercati</span>'+referenceText+'</div><div class="market-table-wrap"><table class="market-table"><thead><tr>'+
      '<th>Mercato</th><th>Stato</th><th>Prezzo attuale</th><th>BuyBox</th><th>Prezzo minimo per vincere</th><th>Acquisto suggerito</th><th>Guadagno 12%</th><th>Guadagno 5%</th>'+
      '</tr></thead><tbody>'+competitors.map(function(competitor){
        var winner = buyboxAmount(competitor,"winner_price");
        var result12 = listingEconomics(listing,"fee12",competitor);
        var result5 = listingEconomics(listing,"fee5",competitor);
        var statusClass = view.isReference ? "market-reference" : competitor.is_winning ? "market-winning" : "market-losing";
        var statusLabel = view.isReference ? "Riferimento" : competitor.is_winning ? "Vinta" : "Persa";
        return '<tr class="'+statusClass+'"><td><span class="market-code">'+escapeHtml(marketLabel(competitor.market))+'</span></td>'+
          '<td><span class="market-status">'+escapeHtml(statusLabel)+'</span></td>'+
          '<td>'+escapeHtml(buyboxMoney(competitor,"price",listing.currency))+'</td>'+
          '<td><strong>'+escapeHtml(winner ? buyboxMoney(competitor,"winner_price",listing.currency) : "Nessuna")+'</strong></td>'+
          '<td><strong class="price-to-win">'+escapeHtml(buyboxMoney(competitor,"price_to_win",listing.currency))+'</strong></td>'+
          '<td><span class="calc-value">'+escapeHtml(suggestedHtml(listing,competitor))+'</span></td>'+
          '<td>'+marginHtml(result12)+'</td><td>'+marginHtml(result5)+'</td></tr>';
      }).join("")+'</tbody></table></div></div>';
  }

  function variantRow(listing){
    var result12 = listingEconomics(listing,"fee12");
    var result5 = listingEconomics(listing,"fee5");
    var open = Boolean(state.openListings[listing.id]);
    var view = displayEntryForListing(listing);
    var entry = view.entry;
    var marketCount = competitorsFromEntry(entry).length;
    var marketButtonLabel = entry && entry.loading ? "Caricamento mercati…" : marketCount ? marketCount+" paesi"+(view.isReference?" · riferimento":"") : "Mostra paesi";
    return '<tr class="variant-row" data-listing-id="'+escapeHtml(listing.id)+'">'+
      '<td><div class="product-title">'+escapeHtml(listing.title)+'</div><div class="sku">SKU: '+escapeHtml(listing.sku || "Non disponibile")+'</div><button class="market-toggle" type="button" data-market-toggle="'+escapeHtml(listing.id)+'" aria-expanded="'+open+'">'+escapeHtml(marketButtonLabel)+' <span>⌄</span></button></td>'+
      '<td>'+escapeHtml(listing.color)+'</td>'+
      '<td>'+escapeHtml(listing.capacity)+'</td>'+
      '<td><div class="variant-stack"><span class="quality-chip">'+escapeHtml(listing.quality)+'</span><span class="battery-chip">'+escapeHtml(listing.batteryLabel)+'</span></div></td>'+
      '<td><span class="quantity-value">'+escapeHtml(listing.quantity)+'</span></td>'+
      '<td><div class="win-loss-summary">'+winLossHtml(listing)+'</div></td>'+
      '<td><span class="calc-value">'+escapeHtml(suggestedHtml(listing))+'</span></td>'+
      '<td><input class="purchase-input" data-purchase-id="'+escapeHtml(listing.id)+'" inputmode="decimal" placeholder="€" value="'+escapeHtml(state.purchases[listing.id] || "")+'"></td>'+
      '<td>'+marginHtml(result12)+'</td>'+
      '<td>'+marginHtml(result5)+'</td>'+
    '</tr>'+(open ? '<tr class="market-detail-row"><td colspan="10">'+marketRowsHtml(listing)+'</td></tr>' : '');
  }

  function familyCard(name,items){
    var open = Boolean(state.openFamilies[name]);
    var capacities = Array.from(new Set(items.map(function(item){ return item.capacity; }))).slice(0,4);
    return '<article class="family-card'+(open?' open':'')+'" data-family="'+escapeHtml(name)+'">'+
      '<button class="family-toggle" type="button" data-family-toggle="'+escapeHtml(name)+'" aria-expanded="'+open+'">'+
        '<span class="family-main"><span class="family-icon">▣</span><span><span class="family-name">'+escapeHtml(name)+'</span><span class="family-meta"><span class="count-chip">'+items.length+' varianti</span>'+capacities.map(function(value){ return '<span class="meta-chip">'+escapeHtml(value)+'</span>'; }).join("")+'</span></span></span>'+
        '<span class="chevron">⌄</span>'+
      '</button>'+
      '<div class="family-body"><table class="variant-table"><colgroup><col style="width:21%"><col style="width:8%"><col style="width:7%"><col style="width:14%"><col style="width:5%"><col style="width:11%"><col style="width:9%"><col style="width:9%"><col style="width:8%"><col style="width:8%"></colgroup><thead><tr>'+
        '<th>Modello</th><th>Colore</th><th>Capacità</th><th>Qualità</th><th>Quantità</th><th><span class="header-win">Vinte</span> / <span class="header-loss">Perse</span></th><th>Prezzo suggerito IT</th><th>Prezzo d’acquisto</th><th>Guadagno 12%</th><th>Guadagno 5%</th>'+
      '</tr></thead><tbody>'+items.map(variantRow).join("")+'</tbody></table></div></article>';
  }

  function renderCatalog(){
    var filtered = filteredListings();
    var groups = groupListings(filtered);
    byId("resultCount").textContent = filtered.length + (filtered.length === 1 ? " inserzione" : " inserzioni");
    byId("catalog").innerHTML = groups.map(function(group){ return familyCard(group[0],group[1]); }).join("");
    byId("emptyState").hidden = groups.length > 0;
    if(groups.length === 0 && state.listings.length > 0){ byId("emptyMessage").textContent = "Nessuna variante corrisponde ai filtri selezionati."; }
    bindRenderedCatalog();
  }

  function bindRenderedCatalog(){
    document.querySelectorAll("[data-family-toggle]").forEach(function(button){
      button.addEventListener("click",function(){
        var family = button.getAttribute("data-family-toggle");
        state.openFamilies[family] = !state.openFamilies[family];
        renderCatalog();
        if(state.openFamilies[family]){
          var items = filteredListings().filter(function(item){ return item.family === family; });
          loadFamilyBuyboxes(family,items);
        }
      });
    });
    document.querySelectorAll("[data-market-toggle]").forEach(function(button){
      button.addEventListener("click",function(){
        var id = button.getAttribute("data-market-toggle");
        state.openListings[id] = !state.openListings[id];
        renderCatalog();
      });
    });
    document.querySelectorAll("[data-purchase-id]").forEach(function(input){
      input.addEventListener("input",function(){
        var id = input.getAttribute("data-purchase-id");
        state.purchases[id] = input.value;
        writeJson(config.purchaseCacheKey,state.purchases);
      });
      input.addEventListener("change",function(){
        renderCatalog();
      });
    });
  }

  async function loadFamilyBuyboxes(family,items){
    if(state.loadingFamilies[family]) return;
    var pending = items.filter(function(item){ return !state.buyboxes[item.id] || state.buyboxes[item.id].error; });
    if(!pending.length) return;
    state.loadingFamilies[family] = true;
    for(var index=0; index<pending.length; index+=1){
      var listing = pending[index];
      state.buyboxes[listing.id] = {loading:true};
      renderCatalog();
      try{
        state.buyboxes[listing.id] = await apiFetch("/api/backbox/"+encodeURIComponent(listing.id));
      }catch(error){
        if(error.code === "ACCESS_REQUIRED"){
          state.buyboxes[listing.id] = {error:"Accesso richiesto"};
          showAccessDialog();
          break;
        }
        state.buyboxes[listing.id] = {error:error.message || "BuyBox non disponibile"};
      }
      renderCatalog();
      if(index < pending.length-1) await sleep(550);
    }
    state.loadingFamilies[family] = false;
  }

  function setStatus(message){ byId("catalogStatus").textContent = message; }
  function cachedCatalog(){
    var cached = readJson(config.catalogCacheKey);
    return cached && Array.isArray(cached.results) ? cached : null;
  }
  function applyCatalog(payload,source){
    state.listings = (payload.results || []).map(core.normalizeListing).filter(function(item){ return item.id; });
    state.updatedAt = payload.updated_at || new Date().toISOString();
    state.source = source;
    renderFilters();
    renderCatalog();
    var timestamp = new Intl.DateTimeFormat("it-IT",{dateStyle:"short",timeStyle:"short"}).format(new Date(state.updatedAt));
    setStatus((source === "cache" ? "Ultima copia salvata · " : "Aggiornato · ") + timestamp);
  }

  async function loadCatalog(force){
    byId("refreshCatalog").disabled = true;
    setStatus(force ? "Aggiornamento in corso…" : "Connessione al catalogo…");
    try{
      var payload = await apiFetch("/api/catalog"+(force?"?refresh=1":""));
      writeJson(config.catalogCacheKey,payload);
      applyCatalog(payload,"live");
    }catch(error){
      if(error.code === "ACCESS_REQUIRED"){
        var cached = cachedCatalog();
        if(cached) applyCatalog(cached,"cache");
        else { state.listings=[]; renderCatalog(); setStatus("Inserisci il codice di accesso"); }
        showAccessDialog();
      }else{
        var fallback = cachedCatalog();
        if(fallback){ applyCatalog(fallback,"cache"); setStatus("API non disponibile · visualizzo l’ultima copia salvata"); }
        else{
          state.listings=[]; renderCatalog();
          byId("emptyMessage").textContent = "La Worker non è ancora configurata o non è raggiungibile.";
          setStatus("API non configurata");
        }
      }
    }finally{ byId("refreshCatalog").disabled = false; }
  }

  function showAccessDialog(){
    var dialog = byId("accessDialog");
    if(!dialog.open) dialog.showModal();
    setTimeout(function(){ byId("accessKey").focus(); },0);
  }

  function bindStaticControls(){
    ["searchInput","brandFilter","capacityFilter","colorFilter","qualityFilter"].forEach(function(id){
      byId(id).addEventListener(id === "searchInput" ? "input" : "change",renderCatalog);
    });
    byId("clearFilters").addEventListener("click",function(){
      byId("searchInput").value="";
      ["brandFilter","capacityFilter","colorFilter","qualityFilter"].forEach(function(id){ byId(id).value=""; });
      renderCatalog();
    });
    byId("refreshCatalog").addEventListener("click",function(){ loadCatalog(true); });
    byId("accessForm").addEventListener("submit",async function(event){
      event.preventDefault();
      var key = byId("accessKey").value.trim();
      if(!key) return;
      setAccessKey(key);
      byId("accessError").hidden = true;
      try{
        await loadCatalog(true);
        if(accessKey()){
          byId("accessDialog").close();
          byId("accessKey").value="";
        }
      }catch(error){
        clearAccessKey();
        byId("accessError").hidden = false;
      }
    });
    window.addEventListener(settingsApi.EVENT_NAME,function(event){
      state.settings = event.detail || settingsApi.load();
      renderSettings();
      renderCatalog();
    });
  }

  renderSettings();
  bindStaticControls();
  renderCatalog();
  loadCatalog(false);
})();
