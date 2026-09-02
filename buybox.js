(function(){
  "use strict";

  var config = window.BUYBOX_CONFIG;
  var core = window.BuyboxCore;
  var settingsApi = window.CalcoloSettings;
  var state = {
    listings:[],
    settings:settingsApi.load(),
    purchases:readJson(config.purchaseCacheKey) || {},
    productMargins:readJson(config.productMarginCacheKey) || {},
    quantityDrafts:{},
    priceDrafts:{},
    buyboxes:{},
    buyboxHistory:readJson(config.buyboxHistoryCacheKey) || {},
    listingMarkets:{},
    loadingListingMarkets:{},
    actionStatus:{},
    openFamilies:{},
    loadingFamilies:{},
    detailListingId:new URLSearchParams(window.location.search).get("listing") || "",
    catalogScrollY:0,
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
    if(options.body !== undefined) headers.set("Content-Type","application/json");
    var response = await fetch(apiUrl(path), {
      method:options.method || "GET",
      headers:headers,
      cache:"no-store",
      body:options.body === undefined ? undefined : JSON.stringify(options.body)
    });
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
      "Fissi altri Paesi: " + core.formatMoney(settings.shipping+settings.importFee),
      "Fissi Italia: " + core.formatMoney(settings.shippingItaly+settings.importFee),
      "Margine minimo: " + (settings.minimumMargin*100).toFixed(2).replace(".",",") + "%",
      "Margine obiettivo: " + (settings.targetMargin*100).toFixed(2).replace(".",",") + "%",
      "1 SEK: " + settings.sekRate.toFixed(3).replace(".",",") + " €"
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
    var entries = Array.from(groups.entries());
    entries.forEach(function(group){
      group[1].sort(function(a,b){
        return b.quantity-a.quantity || a.title.localeCompare(b.title,"it",{numeric:true}) || a.sku.localeCompare(b.sku,"it",{numeric:true});
      });
    });
    return entries.sort(function(a,b){
      var quantityA = a[1].reduce(function(total,item){ return total+item.quantity; },0);
      var quantityB = b[1].reduce(function(total,item){ return total+item.quantity; },0);
      return quantityB-quantityA || a[0].localeCompare(b[0],"it",{numeric:true});
    });
  }

  function productMarginValues(listingId){
    var defaults = core.numericSettings(state.settings);
    var saved = state.productMargins[listingId] || {};
    return {
      minimum:saved.minimum !== undefined ? saved.minimum : (defaults.minimumMargin*100).toFixed(2).replace(".",","),
      target:saved.target !== undefined ? saved.target : (defaults.targetMargin*100).toFixed(2).replace(".",",")
    };
  }

  function marginClass(value,listingId){
    var margins = productMarginValues(listingId);
    var minimum = core.toNumber(margins.minimum)/100;
    var target = core.toNumber(margins.target)/100;
    if(value < minimum) return "bad";
    if(value < target) return "warn";
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
  function equivalentListing(candidate,listing){
    return candidate.id !== listing.id && candidate.productId === listing.productId &&
      candidate.quality === listing.quality && candidate.batteryLabel === listing.batteryLabel &&
      candidate.simType === listing.simType;
  }
  function historicalEntry(listing){
    var saved = state.buyboxHistory[listing.id];
    if(!saved || !Array.isArray(saved.competitors) || !saved.competitors.length) return null;
    return {competitors:saved.competitors,updatedAt:saved.updatedAt};
  }
  function displayEntryForListing(listing){
    var direct = state.buyboxes[listing.id];
    if(competitorsFromEntry(direct).length || (direct && direct.loading)){
      return {entry:direct,isReference:false,source:null,referenceKind:null,updatedAt:null};
    }
    if(listing.quantity <= 0 && listing.productId){
      var source = state.listings.find(function(candidate){
        return candidate.quantity > 0 && equivalentListing(candidate,listing) && competitorsFromEntry(state.buyboxes[candidate.id]).length;
      });
      if(source){
        return {entry:state.buyboxes[source.id],isReference:true,source:source,referenceKind:"active",updatedAt:null};
      }
      var ownHistory = historicalEntry(listing);
      if(ownHistory){
        return {entry:ownHistory,isReference:true,source:listing,referenceKind:"history",updatedAt:ownHistory.updatedAt};
      }
      var historicalSource = state.listings.find(function(candidate){
        return equivalentListing(candidate,listing) && historicalEntry(candidate);
      });
      if(historicalSource){
        var history = historicalEntry(historicalSource);
        return {entry:history,isReference:true,source:historicalSource,referenceKind:"history",updatedAt:history.updatedAt};
      }
    }
    return {entry:direct,isReference:false,source:null,referenceKind:null,updatedAt:null};
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
  function priceEconomics(listing,market,amount,currency){
    var fee = core.marketFee(state.settings,market);
    var amountEuro = core.amountToEuro(amount,currency,state.settings);
    var purchase = core.toNumber(state.purchases[listing.id]);
    if(!amountEuro || !purchase || fee === null) return null;
    return core.calculateMargin(amountEuro,purchase,fee,state.settings,market);
  }

  function listingEconomics(listing,competitor){
    competitor = competitor || competitorForMarket(displayEntryForListing(listing).entry,config.market);
    var backbox = buyboxAmount(competitor,"winner_price");
    var market = String(competitor && competitor.market || config.market).toUpperCase();
    return priceEconomics(listing,market,backbox,buyboxCurrency(competitor,"winner_price",listing.currency));
  }

  function marginHtml(result,listingId){
    if(!result) return '<span class="loading-cell">—</span>';
    return '<span class="margin-pill '+marginClass(result.margin,listingId)+'">'+
      escapeHtml(core.formatMoney(result.profit))+'<small>'+escapeHtml(core.formatPercent(result.margin))+'</small></span>';
  }

  function compactMarginHtml(result,listingId){
    if(!result) return '<span class="price-result empty">—</span>';
    return '<span class="price-result '+marginClass(result.margin,listingId)+'">'+
      escapeHtml(core.formatMoney(result.profit,"EUR"))+' · '+escapeHtml(core.formatPercent(result.margin))+'</span>';
  }

  function winLossValueHtml(listing,kind){
    var view = displayEntryForListing(listing);
    var entry = view.entry;
    if(!entry) return '<span class="loading-cell" title="Apri la famiglia per caricare le BuyBox">—</span>';
    if(entry.loading) return '<span class="loading-cell">…</span>';
    if(view.isReference) return kind === "wins"
      ? '<span class="reference-chip" title="Dati da una variante equivalente">Rif.</span>'
      : '<span class="loading-cell">—</span>';
    if(entry.error) return '<span class="error-cell">—</span>';
    var competitors = competitorsFromEntry(entry);
    if(!competitors.length) return '<span class="loading-cell">—</span>';
    var wins = competitors.filter(function(item){ return item && item.is_winning === true; }).length;
    var losses = competitors.filter(function(item){ return item && item.is_winning === false; }).length;
    return kind === "wins"
      ? '<span class="win-count" title="BuyBox vinte">'+wins+'</span>'
      : '<span class="loss-count" title="BuyBox perse">'+losses+'</span>';
  }

  function averageBackboxEuro(listing,competitor){
    if(!competitor) return null;
    var values = ["winner_price","price_to_win"].map(function(field){
      var amount = buyboxAmount(competitor,field);
      if(!amount) return null;
      return core.amountToEuro(amount,buyboxCurrency(competitor,field,listing.currency),state.settings);
    }).filter(function(value){ return Number.isFinite(value) && value > 0; });
    if(!values.length) return null;
    return values.reduce(function(total,value){ return total+value; },0)/values.length;
  }

  function suggestedHtml(listing,competitor){
    competitor = competitor || competitorForMarket(displayEntryForListing(listing).entry,config.market);
    var referenceEuro = averageBackboxEuro(listing,competitor);
    if(!referenceEuro) return "—";
    var market = String(competitor && competitor.market || config.market).toUpperCase();
    var fee = core.marketFee(state.settings,market);
    if(fee === null) return "Da configurare";
    var targetMargin = core.toNumber(productMarginValues(listing.id).target)/100;
    var suggested = core.suggestedPurchaseForMargin(referenceEuro,fee,targetMargin,state.settings,market);
    return core.formatMoney(suggested,"EUR");
  }

  var MARKET_NAMES = {
    AT:"Austria", BE:"Belgio", DE:"Germania", ES:"Spagna", FI:"Finlandia",
    FR:"Francia", GR:"Grecia", IE:"Irlanda", IT:"Italia", NL:"Paesi Bassi",
    PT:"Portogallo", SE:"Svezia", SK:"Slovacchia"
  };

  function marketLabel(code){
    var market = String(code || "—").toUpperCase();
    var rule = core.marketRule(market);
    return ((rule && rule.name) || MARKET_NAMES[market] || market) + (market === "—" ? "" : " · " + market);
  }

  function inputNumber(value){
    var number = Number(value);
    if(!Number.isFinite(number) || number <= 0) return "";
    return number.toFixed(2).replace(".",",");
  }

  function priceDraftKey(listingId,market){ return listingId+":"+market; }

  function listingMarketData(listingId,market){
    return state.listingMarkets[listingId] && state.listingMarkets[listingId][market] ? state.listingMarkets[listingId][market] : null;
  }

  function priceBaseline(listing,market,competitor,view){
    var detail = listingMarketData(listing.id,market);
    var own = detail && detail.listing;
    if(own){
      return {minimum:own.min_price == null ? null : core.toNumber(own.min_price),target:core.toNumber(own.price)};
    }
    if(!view.isReference && competitor){
      return {minimum:buyboxAmount(competitor,"min_price"),target:buyboxAmount(competitor,"price")};
    }
    if(market === config.market){ return {minimum:listing.minPrice,target:listing.currentPrice}; }
    return {minimum:null,target:null};
  }

  function priceDraft(listing,market,competitor,view){
    var key = priceDraftKey(listing.id,market);
    var baseline = priceBaseline(listing,market,competitor,view);
    var signature = String(baseline.minimum)+":"+String(baseline.target);
    var draft = state.priceDrafts[key];
    if(!draft){
      draft = {minimum:inputNumber(baseline.minimum),target:inputNumber(baseline.target),baseline:signature,dirty:false,message:"",source:"baseline"};
      state.priceDrafts[key] = draft;
    }else if(!draft.dirty && draft.baseline !== signature){
      draft.minimum = inputNumber(baseline.minimum);
      draft.target = inputNumber(baseline.target);
      draft.baseline = signature;
      draft.source = "baseline";
    }
    return draft;
  }

  function quantityDraft(listing){
    if(!state.quantityDrafts[listing.id]){
      state.quantityDrafts[listing.id] = {value:String(listing.quantity),original:String(listing.quantity),dirty:false,message:""};
    }
    return state.quantityDrafts[listing.id];
  }

  function currentBackboxHtml(competitor,view,currency){
    if(!competitor) return '<span class="market-status neutral">Nessun dato BuyBox</span>';
    var label = view.isReference ? "Riferimento" : competitor.is_winning ? "Vinta" : "Persa";
    var winner = buyboxAmount(competitor,"winner_price");
    var detail = winner ? '<strong>'+escapeHtml(buyboxMoney(competitor,"winner_price",currency))+'</strong>' : '<strong>Nessuna</strong>';
    return '<div class="backbox-state"><span class="market-status">'+escapeHtml(label)+'</span>'+detail+'</div>';
  }

  function backboxToBeatHtml(competitor,currency){
    var toWin = buyboxAmount(competitor,"price_to_win");
    if(!toWin) return '<span class="loading-cell">—</span>';
    return '<span class="backbox-target">'+escapeHtml(buyboxMoney(competitor,"price_to_win",currency))+'</span>';
  }

  function marketRowHtml(listing,market,competitor,view){
    var rule = core.marketRule(market);
    var currency = rule ? rule.currency : buyboxCurrency(competitor,"winner_price",listing.currency);
    var draft = priceDraft(listing,market,competitor,view);
    var economics = listingEconomics(listing,competitor);
    var minimumEconomics = priceEconomics(listing,market,draft.minimum,currency);
    var targetEconomics = priceEconomics(listing,market,draft.target,currency);
    var statusClass = !competitor || view.isReference ? "market-reference" : competitor.is_winning ? "market-winning" : "market-losing";
    var loadingDetail = state.loadingListingMarkets[listing.id] && state.loadingListingMarkets[listing.id][market];
    var sendDisabled = !draft.dirty || !draft.minimum || !draft.target;
    var actionMessage = draft.message ? '<small class="action-message">'+escapeHtml(draft.message)+'</small>' : '';
    return '<tr class="'+statusClass+'" data-market-row="'+escapeHtml(market)+'">'+
      '<td><div class="market-name"><strong>'+escapeHtml(marketLabel(market))+'</strong></div></td>'+
      '<td><label class="price-box"><input aria-label="Prezzo minimo ('+escapeHtml(currency)+')" data-price-field="minimum" data-listing-id="'+escapeHtml(listing.id)+'" data-market="'+escapeHtml(market)+'" inputmode="decimal" placeholder="0,00" value="'+escapeHtml(draft.minimum)+'"><span class="currency-suffix">'+escapeHtml(currency)+'</span></label><span data-price-result="minimum">'+(loadingDetail?'<span class="price-result empty">Lettura…</span>':compactMarginHtml(minimumEconomics,listing.id))+'</span></td>'+
      '<td><label class="price-box"><input aria-label="Prezzo target ('+escapeHtml(currency)+')" data-price-field="target" data-listing-id="'+escapeHtml(listing.id)+'" data-market="'+escapeHtml(market)+'" inputmode="decimal" placeholder="0,00" value="'+escapeHtml(draft.target)+'"><span class="currency-suffix">'+escapeHtml(currency)+'</span></label><span data-price-result="target">'+compactMarginHtml(targetEconomics,listing.id)+'</span></td>'+
      '<td>'+currentBackboxHtml(competitor,view,currency)+'</td>'+
      '<td>'+backboxToBeatHtml(competitor,currency)+'</td>'+
      '<td><span class="calc-value">'+escapeHtml(suggestedHtml(listing,competitor))+'</span></td>'+
      '<td>'+marginHtml(economics,listing.id)+'</td>'+
      '<td class="send-cell"><button class="row-send-button" data-send-price="'+escapeHtml(listing.id)+'" data-market="'+escapeHtml(market)+'" type="button"'+(sendDisabled?' disabled':'')+'>Invia</button>'+actionMessage+'</td></tr>';
  }

  function marketRowsHtml(listing){
    var view = displayEntryForListing(listing);
    var entry = view.entry;
    var competitors = competitorsFromEntry(entry);
    var markets = Object.keys(core.MARKET_RULES);
    competitors.forEach(function(competitor){
      var market = String(competitor && competitor.market || "").toUpperCase();
      if(market && markets.indexOf(market) < 0) markets.push(market);
    });
    markets.sort(function(a,b){
      if(a === config.market) return -1;
      if(b === config.market) return 1;
      return marketLabel(a).localeCompare(marketLabel(b),"it");
    });
    var referenceText = "";
    if(view.isReference && view.source){
      referenceText = view.referenceKind === "history"
        ? '<em>Ultimo riferimento salvato'+(view.updatedAt?' · '+escapeHtml(new Intl.DateTimeFormat("it-IT",{dateStyle:"short",timeStyle:"short"}).format(new Date(view.updatedAt))):'')+'</em>'
        : '<em>Riferimento: '+escapeHtml(view.source.sku || view.source.title)+'</em>';
    }
    var errorText = entry && entry.error ? '<em class="panel-warning">'+escapeHtml(entry.error)+'</em>' : '';
    return '<div class="market-panel'+(view.isReference?' reference':'')+'"><div class="market-panel-title"><div>Prezzi per Paese <span>'+markets.length+' mercati</span>'+referenceText+errorText+'</div><div class="market-actions"><button type="button" data-send-all-prices="'+escapeHtml(listing.id)+'">Invia modifiche</button></div></div><div class="market-table-wrap"><table class="market-table"><colgroup><col style="width:13%"><col style="width:15%"><col style="width:15%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:11%"><col style="width:8%"></colgroup><thead><tr>'+
      '<th>Mercato</th><th title="Prezzo minimo">Min</th><th title="Prezzo target">Target</th><th title="BackBox attuale">BB att.</th><th title="BackBox da battere">BB da battere</th><th title="Acquisto consigliato">Acq. cons.</th><th title="Utile netto alla BackBox attuale">Utile BB</th><th aria-label="Invio"></th>'+
      '</tr></thead><tbody>'+markets.map(function(market){ return marketRowHtml(listing,market,competitorForMarket(entry,market),view); }).join("")+'</tbody></table></div></div>';
  }

  function purchaseFieldHtml(listing){
    var purchaseMissing = !core.toNumber(state.purchases[listing.id]);
    return '<div class="field-stack"><label class="purchase-box"><input aria-label="Costo di acquisto" class="purchase-input" data-purchase-id="'+escapeHtml(listing.id)+'" inputmode="decimal" placeholder="0,00" value="'+escapeHtml(state.purchases[listing.id] || "")+'"></label>'+(purchaseMissing?'<small class="economics-note">Costo mancante</small>':'')+'</div>';
  }

  function marginFieldHtml(listing,field,label){
    var margins = productMarginValues(listing.id);
    return '<label class="margin-box"><input aria-label="'+escapeHtml(label)+'" data-margin-field="'+escapeHtml(field)+'" data-margin-id="'+escapeHtml(listing.id)+'" inputmode="decimal" value="'+escapeHtml(margins[field])+'"></label>';
  }

  function recalculateButtonHtml(listing){
    return '<button class="recalculate-button" type="button" data-calculate-prices="'+escapeHtml(listing.id)+'">Ricalcola</button>';
  }

  function quantityEditorHtml(listing){
    var quantity = quantityDraft(listing);
    return '<div class="quantity-editor"><input data-quantity-id="'+escapeHtml(listing.id)+'" inputmode="numeric" value="'+escapeHtml(quantity.value)+'"><button type="button" data-send-quantity="'+escapeHtml(listing.id)+'"'+(quantity.dirty?'':' disabled')+'>Salva</button></div>'+(quantity.message?'<small class="action-message">'+escapeHtml(quantity.message)+'</small>':'');
  }

  function variantRow(listing){
    var view = displayEntryForListing(listing);
    var entry = view.entry;
    var marketCount = competitorsFromEntry(entry).length;
    var marketButtonLabel = entry && entry.loading ? "Caricamento…" : marketCount ? marketCount+" BuyBox"+(view.isReference?" · riferimento":"") : "12 paesi";
    return '<tr class="variant-row" data-listing-id="'+escapeHtml(listing.id)+'">'+
      '<td><div class="product-title">'+escapeHtml(listing.title)+'</div><div class="sku">SKU: '+escapeHtml(listing.sku || "Non disponibile")+'</div></td>'+
      '<td><div class="specification-chips"><span class="quality-chip">'+escapeHtml(listing.quality)+'</span><span class="battery-chip">'+escapeHtml(listing.batteryLabel)+'</span><span class="sim-chip">'+escapeHtml(listing.simType)+'</span></div></td>'+
      '<td class="quantity-cell">'+quantityEditorHtml(listing)+'</td>'+
      '<td class="score-cell">'+winLossValueHtml(listing,"wins")+'</td>'+
      '<td class="score-cell">'+winLossValueHtml(listing,"losses")+'</td>'+
      '<td class="field-cell">'+purchaseFieldHtml(listing)+'</td>'+
      '<td class="field-cell">'+marginFieldHtml(listing,"minimum","Margine minimo percentuale")+'</td>'+
      '<td class="field-cell">'+marginFieldHtml(listing,"target","Margine target percentuale")+'</td>'+
      '<td class="action-cell">'+recalculateButtonHtml(listing)+'</td>'+
      '<td class="action-cell"><button class="market-toggle" type="button" data-open-detail="'+escapeHtml(listing.id)+'">'+escapeHtml(marketButtonLabel)+' <span>→</span></button></td>'+
    '</tr>';
  }

  function productDetailHtml(listing){
    return '<article class="product-detail-page">'+
      '<div class="detail-toolbar"><button class="detail-back" type="button" data-detail-back>← Catalogo</button><span>Dettaglio prodotto</span></div>'+
      '<header class="detail-product-header"><div class="detail-product-main"><div class="detail-title">'+escapeHtml(listing.title)+'</div><div class="sku">SKU: '+escapeHtml(listing.sku || "Non disponibile")+'</div><div class="specification-chips"><span class="quality-chip">'+escapeHtml(listing.quality)+'</span><span class="battery-chip">'+escapeHtml(listing.batteryLabel)+'</span><span class="sim-chip">'+escapeHtml(listing.simType)+'</span></div></div><div class="detail-controls-grid"><div class="detail-control"><span class="detail-label">Costo</span>'+purchaseFieldHtml(listing)+'</div><div class="detail-control"><span class="detail-label">Min %</span>'+marginFieldHtml(listing,"minimum","Margine minimo percentuale")+'</div><div class="detail-control"><span class="detail-label">Target %</span>'+marginFieldHtml(listing,"target","Margine target percentuale")+'</div><div class="detail-action">'+recalculateButtonHtml(listing)+'</div><div class="detail-control detail-stock"><span class="detail-label">Quantità</span>'+quantityEditorHtml(listing)+'</div><div class="detail-control detail-score"><span class="detail-label">Vinte</span>'+winLossValueHtml(listing,"wins")+'</div><div class="detail-control detail-score"><span class="detail-label">Perse</span>'+winLossValueHtml(listing,"losses")+'</div></div></header>'+
      marketRowsHtml(listing)+'</article>';
  }

  function familyCard(name,items){
    var open = Boolean(state.openFamilies[name]);
    var totalQuantity = items.reduce(function(total,item){ return total+item.quantity; },0);
    var capacities = Array.from(new Set(items.map(function(item){ return item.capacity; }))).slice(0,4);
    return '<article class="family-card'+(open?' open':'')+'" data-family="'+escapeHtml(name)+'">'+
      '<button class="family-toggle" type="button" data-family-toggle="'+escapeHtml(name)+'" aria-expanded="'+open+'">'+
        '<span class="family-main"><span class="family-icon">▣</span><span><span class="family-name">'+escapeHtml(name)+'</span><span class="family-meta"><span class="stock-chip">'+escapeHtml(totalQuantity)+' unità</span><span class="count-chip">'+items.length+' varianti</span>'+capacities.map(function(value){ return '<span class="meta-chip">'+escapeHtml(value)+'</span>'; }).join("")+'</span></span></span>'+
        '<span class="chevron">⌄</span>'+
      '</button>'+
      '<div class="family-body"><table class="variant-table"><colgroup><col style="width:23%"><col style="width:18%"><col style="width:10%"><col style="width:5%"><col style="width:5%"><col style="width:10%"><col style="width:7%"><col style="width:8%"><col style="width:7%"><col style="width:7%"></colgroup><thead><tr>'+
        '<th>Prodotto</th><th>Specifiche</th><th>Quantità</th><th class="header-win">Vinte</th><th class="header-loss">Perse</th><th>Costo</th><th>Min %</th><th>Target %</th><th aria-label="Ricalcolo"></th><th aria-label="BuyBox"></th>'+
      '</tr></thead><tbody>'+items.map(variantRow).join("")+'</tbody></table></div></article>';
  }

  function renderCatalog(){
    var filtered = filteredListings();
    var groups = groupListings(filtered);
    var detailListing = state.detailListingId ? listingById(state.detailListingId) : null;
    document.body.classList.toggle("detail-mode",Boolean(state.detailListingId));
    byId("catalog").classList.toggle("detail-catalog",Boolean(state.detailListingId));
    if(state.detailListingId){
      byId("catalog").innerHTML = detailListing
        ? productDetailHtml(detailListing)
        : state.listings.length
          ? '<div class="detail-loading"><strong>Prodotto non disponibile</strong><span>Potrebbe non essere più presente nel catalogo.</span><button class="detail-back" type="button" data-detail-back>← Catalogo</button></div>'
          : '<div class="detail-loading">Caricamento del prodotto…</div>';
      byId("emptyState").hidden = true;
      bindRenderedCatalog();
      return;
    }
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
    document.querySelectorAll("[data-open-detail]").forEach(function(button){
      button.addEventListener("click",function(){
        openListingDetail(button.getAttribute("data-open-detail"));
      });
    });
    document.querySelectorAll("[data-detail-back]").forEach(function(button){
      button.addEventListener("click",closeListingDetail);
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
    document.querySelectorAll("[data-margin-id]").forEach(function(input){
      input.addEventListener("input",function(){
        var id = input.getAttribute("data-margin-id");
        var field = input.getAttribute("data-margin-field");
        var margins = productMarginValues(id);
        margins[field] = input.value;
        state.productMargins[id] = margins;
        writeJson(config.productMarginCacheKey,state.productMargins);
      });
      input.addEventListener("change",function(){ renderCatalog(); });
    });
    document.querySelectorAll("[data-quantity-id]").forEach(function(input){
      input.addEventListener("input",function(){
        var id = input.getAttribute("data-quantity-id");
        var draft = state.quantityDrafts[id];
        draft.value = input.value;
        draft.dirty = draft.value !== draft.original;
        draft.message = "";
        var button = document.querySelector('[data-send-quantity="'+CSS.escape(id)+'"]');
        if(button) button.disabled = !draft.dirty;
      });
    });
    document.querySelectorAll("[data-send-quantity]").forEach(function(button){
      button.addEventListener("click",function(){ sendQuantity(button.getAttribute("data-send-quantity")); });
    });
    document.querySelectorAll("[data-price-field]").forEach(function(input){
      input.addEventListener("input",function(){
        var id = input.getAttribute("data-listing-id");
        var market = input.getAttribute("data-market");
        var field = input.getAttribute("data-price-field");
        var draft = state.priceDrafts[priceDraftKey(id,market)];
        draft[field] = input.value;
        draft.dirty = true;
        draft.source = "manual";
        draft.message = "";
        var listing = listingById(id);
        var rule = core.marketRule(market);
        var resultNode = input.closest("td").querySelector('[data-price-result="'+field+'"]');
        if(resultNode && listing && rule){
          resultNode.innerHTML = compactMarginHtml(priceEconomics(listing,market,input.value,rule.currency),id);
        }
        var button = document.querySelector('[data-send-price="'+CSS.escape(id)+'"][data-market="'+CSS.escape(market)+'"]');
        if(button) button.disabled = !draft.minimum || !draft.target;
      });
    });
    document.querySelectorAll("[data-send-price]").forEach(function(button){
      button.addEventListener("click",function(){ sendPrice(button.getAttribute("data-send-price"),button.getAttribute("data-market"),true); });
    });
    document.querySelectorAll("[data-calculate-prices]").forEach(function(button){
      button.addEventListener("click",function(){ calculateAllMarketPrices(button.getAttribute("data-calculate-prices")); });
    });
    document.querySelectorAll("[data-send-all-prices]").forEach(function(button){
      button.addEventListener("click",function(){ sendAllMarketPrices(button.getAttribute("data-send-all-prices")); });
    });
  }

  function listingById(id){ return state.listings.find(function(item){ return item.id === id; }); }

  function ensureDetailData(){
    var listing = listingById(state.detailListingId);
    if(!listing) return;
    loadFamilyBuyboxes(listing.family,[listing]);
    loadListingMarketDetails(listing);
  }

  function openListingDetail(id){
    var listing = listingById(id);
    if(!listing) return;
    state.catalogScrollY = window.scrollY;
    state.detailListingId = id;
    var url = new URL(window.location.href);
    url.searchParams.set("listing",id);
    history.pushState({buyboxDetail:true,listing:id},"",url.pathname+url.search+url.hash);
    renderCatalog();
    window.scrollTo({top:0,behavior:"auto"});
    ensureDetailData();
  }

  function closeListingDetail(){
    if(history.state && history.state.buyboxDetail){
      history.back();
      return;
    }
    var url = new URL(window.location.href);
    url.searchParams.delete("listing");
    history.replaceState(null,"",url.pathname+url.search+url.hash);
    state.detailListingId = "";
    renderCatalog();
    window.scrollTo({top:state.catalogScrollY,behavior:"auto"});
  }

  function validPriceDraft(draft){
    var minimum = core.toNumber(draft.minimum);
    var target = core.toNumber(draft.target);
    return minimum > 0 && target >= minimum && target <= minimum*1.08+0.000001;
  }

  async function sendQuantity(id){
    var listing = listingById(id);
    var draft = state.quantityDrafts[id];
    var quantity = Number(String(draft.value).trim());
    if(!listing || !Number.isSafeInteger(quantity) || quantity < 0){
      draft.message = "Inserisci una quantità intera valida";
      renderCatalog();
      return;
    }
    var warning = quantity === 0 ? "La listing verrà messa offline in tutti i Paesi." : listing.quantity === 0 ? "La listing verrà riattivata con stock disponibile in tutti i Paesi." : "La quantità sarà aggiornata per tutti i Paesi.";
    if(!window.confirm("Aggiornare “"+listing.title+"” da "+listing.quantity+" a "+quantity+" unità?\n\n"+warning)) return;
    draft.message = "Invio in corso…";
    renderCatalog();
    try{
      await apiFetch("/api/listings/"+encodeURIComponent(id),{method:"POST",body:{quantity:quantity}});
      listing.quantity = quantity;
      draft.value = String(quantity);
      draft.original = String(quantity);
      draft.dirty = false;
      draft.message = "Quantità aggiornata";
    }catch(error){ draft.message = error.message || "Aggiornamento non riuscito"; }
    renderCatalog();
  }

  function calculateAllMarketPrices(id){
    var listing = listingById(id);
    var purchase = listing && core.toNumber(state.purchases[id]);
    if(!listing || !purchase){
      window.alert("Inserisci prima il prezzo d’acquisto della variante.");
      return;
    }
    var margins = productMarginValues(id);
    var minimumMargin = core.toNumber(margins.minimum);
    var targetMargin = core.toNumber(margins.target);
    if(minimumMargin < 0 || targetMargin < minimumMargin){
      window.alert("Controlla i margini del prodotto: il target deve essere uguale o superiore al minimo.");
      return;
    }
    var manualDrafts = Object.keys(core.MARKET_RULES).filter(function(market){
      var draft = state.priceDrafts[priceDraftKey(id,market)];
      return draft && draft.dirty && draft.source === "manual";
    });
    if(manualDrafts.length && !window.confirm("Ricalcolare i prezzi sostituendo le correzioni manuali non ancora inviate per "+manualDrafts.length+" mercati?")) return;
    var view = displayEntryForListing(listing);
    Object.keys(core.MARKET_RULES).forEach(function(market){
      var competitor = competitorForMarket(view.entry,market);
      var draft = priceDraft(listing,market,competitor,view);
      var plan = core.marketPricePlan(purchase,market,state.settings,margins);
      if(plan){
        draft.minimum = inputNumber(plan.minimum);
        draft.target = inputNumber(plan.target);
        draft.dirty = true;
        draft.source = "calculated";
        draft.message = "";
      }
    });
    renderCatalog();
  }

  async function sendPrice(id,market,askConfirmation){
    var listing = listingById(id);
    var draft = state.priceDrafts[priceDraftKey(id,market)];
    var rule = core.marketRule(market);
    if(!listing || !draft || !rule) return false;
    if(!validPriceDraft(draft)){
      draft.message = "Target non valido: deve essere tra il minimo e +8%";
      renderCatalog();
      return false;
    }
    var minimum = core.toNumber(draft.minimum);
    var target = core.toNumber(draft.target);
    if(askConfirmation && !window.confirm("Inviare a Back Market i prezzi per "+marketLabel(market)+"?\n\nMinimo: "+core.formatMoney(minimum,rule.currency)+"\nTarget: "+core.formatMoney(target,rule.currency))) return false;
    draft.message = "Invio in corso…";
    renderCatalog();
    try{
      await apiFetch("/api/listings/"+encodeURIComponent(id),{
        method:"POST",
        body:{market:market,min_price:minimum.toFixed(2),price:target.toFixed(2),currency:rule.currency}
      });
      draft.minimum = inputNumber(minimum);
      draft.target = inputNumber(target);
      draft.baseline = String(minimum)+":"+String(target);
      draft.dirty = false;
      draft.source = "saved";
      draft.message = "Prezzi aggiornati";
      var view = displayEntryForListing(listing);
      if(!view.isReference){
        var competitor = competitorForMarket(view.entry,market);
        if(competitor){
          competitor.min_price = {amount:minimum.toFixed(2),currency:rule.currency};
          competitor.price = {amount:target.toFixed(2),currency:rule.currency};
        }
      }
      if(!state.listingMarkets[id]) state.listingMarkets[id] = {};
      state.listingMarkets[id][market] = {listing:{price:target.toFixed(2),min_price:minimum.toFixed(2)}};
      return true;
    }catch(error){
      draft.message = error.message || "Aggiornamento non riuscito";
      renderCatalog();
      return false;
    }
  }

  async function sendAllMarketPrices(id){
    var listing = listingById(id);
    if(!listing) return;
    var dirtyMarkets = Object.keys(core.MARKET_RULES).filter(function(market){
      var draft = state.priceDrafts[priceDraftKey(id,market)];
      return draft && draft.dirty;
    });
    if(!dirtyMarkets.length){ window.alert("Non ci sono modifiche di prezzo da inviare."); return; }
    var invalid = dirtyMarkets.filter(function(market){ return !validPriceDraft(state.priceDrafts[priceDraftKey(id,market)]); });
    if(invalid.length){ window.alert("Controlla i valori di: "+invalid.join(", ")+". Il target deve restare tra il minimo e +8%."); return; }
    if(!window.confirm("Inviare a Back Market le modifiche di prezzo per "+dirtyMarkets.length+" Paesi di “"+listing.title+"”?\n\nLa quantità non verrà modificata.")) return;
    var completed = 0;
    for(var index=0;index<dirtyMarkets.length;index+=1){
      if(await sendPrice(id,dirtyMarkets[index],false)) completed += 1;
      if(index<dirtyMarkets.length-1) await sleep(200);
    }
    renderCatalog();
    window.alert(completed+" di "+dirtyMarkets.length+" mercati aggiornati.");
  }

  async function loadListingMarketDetails(listing){
    var view = displayEntryForListing(listing);
    if(!view.isReference && competitorsFromEntry(view.entry).length) return;
    if(!state.listingMarkets[listing.id]) state.listingMarkets[listing.id] = {};
    if(!state.loadingListingMarkets[listing.id]) state.loadingListingMarkets[listing.id] = {};
    var markets = Object.keys(core.MARKET_RULES).filter(function(market){
      return !state.listingMarkets[listing.id][market] && !state.loadingListingMarkets[listing.id][market];
    });
    for(var index=0;index<markets.length;index+=1){
      var market = markets[index];
      state.loadingListingMarkets[listing.id][market] = true;
      renderCatalog();
      try{
        state.listingMarkets[listing.id][market] = await apiFetch("/api/listings/"+encodeURIComponent(listing.id)+"?market="+encodeURIComponent(market));
      }catch(error){
        state.listingMarkets[listing.id][market] = {error:error.message || "Prezzo non disponibile"};
      }
      state.loadingListingMarkets[listing.id][market] = false;
      renderCatalog();
      if(index<markets.length-1) await sleep(120);
    }
  }

  function saveBuyboxHistory(listingId,payload){
    var competitors = competitorsFromEntry(payload);
    if(!competitors.length) return;
    state.buyboxHistory[listingId] = {updatedAt:new Date().toISOString(),competitors:competitors};
    var keys = Object.keys(state.buyboxHistory).sort(function(a,b){
      return String(state.buyboxHistory[b].updatedAt || "").localeCompare(String(state.buyboxHistory[a].updatedAt || ""));
    });
    keys.slice(250).forEach(function(key){ delete state.buyboxHistory[key]; });
    writeJson(config.buyboxHistoryCacheKey,state.buyboxHistory);
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
        saveBuyboxHistory(listing.id,state.buyboxes[listing.id]);
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
    if(state.detailListingId) ensureDetailData();
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
    window.addEventListener("popstate",function(){
      state.detailListingId = new URLSearchParams(window.location.search).get("listing") || "";
      renderCatalog();
      if(state.detailListingId){
        window.scrollTo({top:0,behavior:"auto"});
        ensureDetailData();
      }else{
        setTimeout(function(){ window.scrollTo({top:state.catalogScrollY,behavior:"auto"}); },0);
      }
    });
  }

  renderSettings();
  bindStaticControls();
  renderCatalog();
  loadCatalog(false);
})();
