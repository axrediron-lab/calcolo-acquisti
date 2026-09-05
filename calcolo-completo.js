(function(){
  "use strict";

  var config = window.BUYBOX_CONFIG;
  var core = window.BuyboxCore;
  var valuation = window.StockValuationCore;
  var settingsApi = window.CalcoloSettings;
  var CACHE_KEY = "calcolo_stock_backbox_v1";
  var state = {
    settings:settingsApi.load(),
    profile:null,
    listings:[],
    families:[],
    selected:null,
    mode:"uniform",
    payloads:readJson(CACHE_KEY) || {},
    benchmarks:null,
    analyzedVariantKeys:[],
    updatedAt:null
  };

  function byId(id){ return document.getElementById(id); }
  function escapeHtml(value){
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }
  function readJson(key){ try{ var raw=localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }catch(error){ return null; } }
  function writeJson(key,value){ try{ localStorage.setItem(key,JSON.stringify(value)); }catch(error){} }
  function accessKey(){ try{ return sessionStorage.getItem(config.accessSessionKey) || ""; }catch(error){ return ""; } }
  function setAccessKey(value){ try{ sessionStorage.setItem(config.accessSessionKey,value); }catch(error){} }
  function clearAccessKey(){ try{ sessionStorage.removeItem(config.accessSessionKey); }catch(error){} }
  function apiUrl(path){ return config.apiBase.replace(/\/$/,"") + path; }
  async function apiFetch(path){
    var headers = new Headers({Accept:"application/json"});
    if(accessKey()) headers.set("X-App-Key",accessKey());
    var response = await fetch(apiUrl(path),{headers:headers,cache:"no-store"});
    var payload=null;
    try{ payload=await response.json(); }catch(error){}
    if(response.status===401){ clearAccessKey(); var unauthorized=new Error("ACCESS_REQUIRED"); unauthorized.code="ACCESS_REQUIRED"; throw unauthorized; }
    if(!response.ok) throw new Error(payload && payload.error ? payload.error : "Servizio non disponibile");
    return payload;
  }
  function euro(value){ return core.formatMoney(value,"EUR"); }
  function pct(value){ return core.formatPercent(value); }
  function number(value){ return core.toNumber(value); }

  function renderProfile(){
    state.profile=settingsApi.resolveProfile(state.settings,"purchases");
    var numeric=core.numericSettings(state.profile);
    byId("targetMargin").value=(numeric.targetMargin*100).toFixed(2).replace(".",",");
    byId("profileChips").innerHTML=[
      "BM 12%: "+(numeric.fee12*100).toFixed(2).replace(".",",")+"%",
      "BM 5%: "+(numeric.fee5*100).toFixed(2).replace(".",",")+"%",
      "Ingresso: "+euro(numeric.acquisitionImport+numeric.acquisitionShipping),
      "1 SEK: "+numeric.sekRate.toFixed(3).replace(".",",")+" €"
    ].map(function(label){ return '<span>'+escapeHtml(label)+'</span>'; }).join("");
    byId("profileRules").innerHTML=[
      ["Fee extra",(numeric.investorFee+numeric.storfundFee+numeric.paymentFee)*100,"%"],
      ["Importazione acquisto",numeric.acquisitionImport," €"],
      ["Spedizione acquisto",numeric.acquisitionShipping," €"],
      ["Spedizione vendita Italia",numeric.shippingItaly," €"],
      ["Spedizione vendita altri Paesi",numeric.shipping," €"]
    ].map(function(row){ return '<div><span>'+escapeHtml(row[0])+'</span><strong>'+escapeHtml(row[1].toFixed(2).replace(".",",")+row[2])+'</strong></div>'; }).join("");
  }

  function showAccessDialog(){ var dialog=byId("accessDialog"); if(!dialog.open) dialog.showModal(); setTimeout(function(){ byId("accessKey").focus(); },0); }
  function cachedCatalog(){ var cached=readJson(config.catalogCacheKey); return cached && Array.isArray(cached.results) ? cached : null; }
  function applyCatalog(payload,source){
    state.listings=(payload.results||[]).map(core.normalizeListing).filter(function(item){ return item.id; });
    state.families=valuation.groupFamilies(state.listings);
    state.updatedAt=payload.updated_at||new Date().toISOString();
    var time=new Intl.DateTimeFormat("it-IT",{dateStyle:"short",timeStyle:"short"}).format(new Date(state.updatedAt));
    byId("catalogStatus").textContent=(source==="cache"?"Ultima copia salvata · ":"Catalogo aggiornato · ")+time+" · "+state.families.length+" famiglie";
    renderFamilyResults();
  }
  async function loadCatalog(force){
    byId("refreshCatalog").disabled=true;
    byId("catalogStatus").textContent=force?"Aggiornamento catalogo…":"Connessione al catalogo…";
    try{
      try{
        var settingsPayload=await settingsApi.loadOnline(config.apiBase,accessKey());
        if(settingsPayload && settingsPayload.settings){ state.settings=settingsPayload.settings; renderProfile(); }
      }catch(settingsError){
        if(settingsError.status===401 || settingsError.code==="ACCESS_REQUIRED") throw settingsError;
      }
      var payload=await apiFetch("/api/catalog"+(force?"?refresh=1":""));
      writeJson(config.catalogCacheKey,payload);
      applyCatalog(payload,"live");
      return true;
    }catch(error){
      var cached=cachedCatalog();
      if(cached) applyCatalog(cached,"cache");
      else byId("catalogStatus").textContent="Catalogo non disponibile";
      if(error.code==="ACCESS_REQUIRED" || error.status===401) showAccessDialog();
      return false;
    }finally{ byId("refreshCatalog").disabled=false; }
  }

  function matchingFamilies(){
    var query=core.normalizeSearchText(byId("familySearch").value);
    if(!query) return state.families.slice(0,8);
    var tokens=query.split(" ").filter(Boolean);
    return state.families.filter(function(group){
      var haystack=core.normalizeSearchText(group.label+" "+group.brand);
      return tokens.every(function(token){ return haystack.indexOf(token)>=0; });
    }).slice(0,12);
  }
  function renderFamilyResults(){
    if(state.selected){ byId("familyResults").innerHTML=""; return; }
    var results=matchingFamilies();
    byId("familyResults").innerHTML=results.map(function(group){
      return '<button type="button" role="option" data-family="'+escapeHtml(group.key)+'"><strong>'+escapeHtml(group.family+' · '+group.capacity)+'</strong><span>'+escapeHtml(group.simLabel)+' · '+group.variants.length+' varianti · '+group.listings.length+' colori/listing</span></button>';
    }).join("") || '<p class="no-family">Nessuna famiglia corrisponde alla ricerca.</p>';
  }
  function selectFamily(key){
    state.selected=state.families.find(function(group){ return group.key===key; })||null;
    state.benchmarks=null;
    if(!state.selected) return;
    byId("familyResults").innerHTML="";
    byId("familySearch").hidden=true;
    byId("selectedFamily").hidden=false;
    byId("selectedFamily").innerHTML='<div><strong>'+escapeHtml(state.selected.family+' · '+state.selected.capacity)+'</strong><span>'+escapeHtml(state.selected.simLabel)+' · '+state.selected.variants.length+' varianti</span></div><button type="button" data-change-family>Cambia</button>';
    byId("stockDetailsPanel").hidden=false;
    byId("compositionPanel").hidden=false;
    renderComposition();
    resetResults();
  }
  function changeFamily(){
    state.selected=null; state.benchmarks=null;
    byId("familySearch").hidden=false; byId("familySearch").value="";
    byId("selectedFamily").hidden=true; byId("stockDetailsPanel").hidden=true; byId("compositionPanel").hidden=true;
    resetResults(); renderFamilyResults(); byId("familySearch").focus();
  }

  function variantOptions(){
    return state.selected.variants.map(function(variant,index){ return '<option value="'+escapeHtml(variant.key)+'"'+(index===0?' selected':'')+'>'+escapeHtml(variant.label+' · '+variant.colors.length+' colori')+'</option>'; }).join("");
  }
  function renderComposition(){
    var editor=byId("compositionEditor");
    if(state.mode==="uniform"){
      editor.innerHTML='<label class="composition-label">Grado e batteria<select id="uniformVariant">'+variantOptions()+'</select></label>';
    }else if(state.mode==="mixed"){
      editor.innerHTML='<div class="mix-table-wrap"><table class="mix-table"><thead><tr><th>Variante</th><th>Colori</th><th>Quantità</th></tr></thead><tbody>'+state.selected.variants.map(function(variant){
        return '<tr><td><strong>'+escapeHtml(variant.label)+'</strong></td><td>'+variant.colors.length+'</td><td><input type="number" min="0" step="1" value="0" data-mix-variant="'+escapeHtml(variant.key)+'" aria-label="Quantità '+escapeHtml(variant.label)+'"></td></tr>';
      }).join("")+'</tbody></table></div><p id="mixTotal" class="mix-total"></p>';
      updateMixTotal();
    }else{
      editor.innerHTML='<p class="composition-help">Seleziona le varianti che potrebbero essere presenti. Il risultato parte dallo scenario prudente.</p><div class="uncertain-list">'+state.selected.variants.map(function(variant){
        return '<label><input type="checkbox" data-uncertain-variant="'+escapeHtml(variant.key)+'" checked><span><strong>'+escapeHtml(variant.label)+'</strong><small>'+variant.colors.length+' colori</small></span></label>';
      }).join("")+'</div>';
    }
  }
  function setMode(mode){
    state.mode=mode; state.benchmarks=null;
    document.querySelectorAll("[data-mode]").forEach(function(button){ button.setAttribute("aria-selected",String(button.dataset.mode===mode)); });
    renderComposition(); resetResults();
  }
  function mixWeights(){
    return Array.from(document.querySelectorAll("[data-mix-variant]")).map(function(input){ return {variantKey:input.dataset.mixVariant,weight:number(input.value)}; }).filter(function(item){ return item.weight>0; });
  }
  function uncertainKeys(){ return Array.from(document.querySelectorAll("[data-uncertain-variant]:checked")).map(function(input){ return input.dataset.uncertainVariant; }); }
  function selectedVariantKeys(){
    if(state.mode==="uniform") return [byId("uniformVariant").value];
    if(state.mode==="mixed") return mixWeights().map(function(item){ return item.variantKey; });
    return uncertainKeys();
  }
  function updateMixTotal(){
    var total=mixWeights().reduce(function(sum,item){ return sum+item.weight; },0);
    var expected=Math.max(number(byId("stockQuantity").value),0);
    var node=byId("mixTotal");
    if(!node) return;
    node.textContent="Totale assegnato: "+total+" / "+expected;
    node.className="mix-total "+(total===expected && total>0?"is-ok":"is-warning");
  }

  async function runQueue(tasks,limit,onProgress){
    var cursor=0,done=0;
    async function worker(){
      while(cursor<tasks.length){
        var index=cursor++; await tasks[index](); done+=1; onProgress(done,tasks.length);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,tasks.length)},worker));
  }
  async function analyze(){
    if(!state.selected) return;
    var keys=selectedVariantKeys();
    var quantity=Math.max(number(byId("stockQuantity").value),0);
    if(!keys.length){ byId("analysisProgress").textContent="Seleziona almeno una variante."; return; }
    if(state.mode==="mixed"){
      var assigned=mixWeights().reduce(function(total,item){ return total+item.weight; },0);
      if(!quantity || assigned!==quantity){ byId("analysisProgress").textContent="Le quantità del mix devono coincidere con la quantità totale."; return; }
    }
    var listings=state.selected.listings.filter(function(item){ return keys.includes(item.variantKey); });
    var missing=listings;
    byId("analyzeStock").disabled=true;
    try{
      await runQueue(missing.map(function(listing){ return async function(){ state.payloads[listing.id]=await apiFetch("/api/backbox/"+encodeURIComponent(listing.id)); }; }),4,function(done,total){
        byId("analysisProgress").textContent="Lettura BuyBox: "+done+" / "+total;
      });
      writeJson(CACHE_KEY,state.payloads);
      state.analyzedVariantKeys=keys;
      state.benchmarks=valuation.buildVariantBenchmarks(listings,state.payloads,state.profile);
      byId("analysisProgress").textContent="BuyBox lette. I calcoli ora si aggiornano in tempo reale.";
      renderResults();
    }catch(error){
      if(error.code==="ACCESS_REQUIRED") showAccessDialog();
      byId("analysisProgress").textContent="Non è stato possibile completare la lettura delle BuyBox.";
    }finally{ byId("analyzeStock").disabled=false; }
  }

  function currentComposition(){
    if(state.mode==="uniform") return valuation.weightedMarkets(state.benchmarks,[{variantKey:byId("uniformVariant").value,weight:1}]);
    if(state.mode==="mixed") return valuation.weightedMarkets(state.benchmarks,mixWeights());
    return valuation.uncertainMarkets(state.benchmarks,uncertainKeys(),byId("uncertainScenario").value);
  }
  function resultCard(label,description,result,target){
    if(!result) return '<article class="result-card unavailable"><div><span class="result-label">'+escapeHtml(label)+'</span><small>'+escapeHtml(description)+'</small></div><strong>Dati non disponibili</strong></article>';
    var status=result.margin>=target?"ok":result.margin>=target-.02?"warn":"bad";
    return '<article class="result-card '+status+'"><div class="result-card-head"><div><span class="result-label">'+escapeHtml(label)+'</span><small>'+escapeHtml(description)+'</small></div><strong>'+escapeHtml(euro(result.salePrice))+'</strong></div><dl><div><dt>Margine netto</dt><dd>'+escapeHtml(pct(result.margin))+'</dd></div><div><dt>Utile / unità</dt><dd>'+escapeHtml(euro(result.profit))+'</dd></div><div><dt>Utile stock</dt><dd>'+escapeHtml(euro(result.totalProfit))+'</dd></div><div><dt>Acquisto massimo</dt><dd>'+escapeHtml(euro(result.maximumPurchase))+'</dd></div></dl><p>'+result.markets+' Paesi · copertura '+Math.round(result.coverage*100)+'%</p></article>';
  }
  function renderResults(){
    if(!state.benchmarks){ resetResults(); return; }
    var purchase=number(byId("supplierPrice").value);
    var quantity=Math.max(number(byId("stockQuantity").value),0);
    var target=number(byId("targetMargin").value)/100;
    var composed=currentComposition();
    var france=valuation.evaluateGroup(composed,["FR"],purchase,quantity,target,state.profile);
    var group12=valuation.evaluateGroup(composed,valuation.GROUP_12,purchase,quantity,target,state.profile);
    var group5=valuation.evaluateGroup(composed,valuation.GROUP_5,purchase,quantity,target,state.profile);
    var results=[france,group12,group5].filter(Boolean);
    byId("resultsEmpty").hidden=true; byId("resultsContent").hidden=false;
    byId("scenarioControl").hidden=state.mode!=="uncertain";
    byId("resultTitle").textContent=state.selected.family+" · "+state.selected.capacity;
    byId("resultCards").innerHTML=[
      resultCard("Francia","Riferimento diretto",france,target),
      resultCard("Media Paesi 12%","Italia, Belgio, Spagna, Francia, Grecia, Slovacchia",group12,target),
      resultCard("Media Paesi 5%","Austria, Finlandia, Irlanda, Paesi Bassi, Portogallo, Svezia",group5,target)
    ].join("");
    var badge=byId("decisionBadge");
    if(!purchase){ badge.className="decision-badge neutral"; badge.textContent="Inserisci il prezzo fornitore"; }
    else if(results.length && results.every(function(item){ return item.margin>=target; })){ badge.className="decision-badge ok"; badge.textContent="Conveniente"; }
    else if(results.length && results.every(function(item){ return item.margin>=target-.02; })){ badge.className="decision-badge warn"; badge.textContent="Al limite"; }
    else { badge.className="decision-badge bad"; badge.textContent="Non conveniente"; }
    var marketEntries=Object.keys(composed.markets).map(function(market){ return {market:market,entry:composed.markets[market]}; });
    byId("coverageSummary").textContent=marketEntries.length+" Paesi con dati su 12. I valori mancanti sono esclusi dalle medie.";
    byId("marketCoverage").innerHTML=Object.keys(core.MARKET_RULES).map(function(market){
      var entry=composed.markets[market];
      return '<span class="'+(entry?'available':'missing')+'"><strong>'+market+'</strong> '+(entry?Math.round(entry.coverage*100)+"%":"—")+'</span>';
    }).join("");
    byId("benchmarkTimestamp").textContent="Calcolato "+new Intl.DateTimeFormat("it-IT",{timeStyle:"short"}).format(new Date());
  }
  function resetResults(){ byId("resultsEmpty").hidden=false; byId("resultsContent").hidden=true; }

  function bind(){
    byId("familySearch").addEventListener("input",renderFamilyResults);
    byId("familyResults").addEventListener("click",function(event){ var button=event.target.closest("[data-family]"); if(button) selectFamily(button.dataset.family); });
    byId("selectedFamily").addEventListener("click",function(event){ if(event.target.closest("[data-change-family]")) changeFamily(); });
    document.querySelectorAll("[data-mode]").forEach(function(button){ button.addEventListener("click",function(){ setMode(button.dataset.mode); }); });
    byId("compositionEditor").addEventListener("input",function(){
      updateMixTotal();
      if(!state.benchmarks) return;
      var current=selectedVariantKeys().slice().sort().join("|");
      var analyzed=state.analyzedVariantKeys.slice().sort().join("|");
      if(current!==analyzed){
        state.benchmarks=null;
        byId("analysisProgress").textContent="Composizione cambiata: aggiorna l’analisi BuyBox.";
        resetResults();
      }else renderResults();
    });
    ["stockQuantity","supplierPrice","targetMargin"].forEach(function(id){ byId(id).addEventListener("input",function(){ updateMixTotal(); if(state.benchmarks) renderResults(); }); });
    byId("uncertainScenario").addEventListener("change",renderResults);
    byId("analyzeStock").addEventListener("click",analyze);
    byId("refreshCatalog").addEventListener("click",function(){ loadCatalog(true); });
    byId("accessForm").addEventListener("submit",async function(event){
      event.preventDefault(); var key=byId("accessKey").value.trim(); if(!key) return;
      setAccessKey(key); byId("accessError").hidden=true;
      try{
        var loaded=await loadCatalog(true);
        if(loaded && accessKey()){ byId("accessDialog").close(); byId("accessKey").value=""; }
        else byId("accessError").hidden=false;
      }catch(error){ clearAccessKey(); byId("accessError").hidden=false; }
    });
    window.addEventListener(settingsApi.EVENT_NAME,function(event){ state.settings=event.detail||settingsApi.load(); renderProfile(); if(state.benchmarks) renderResults(); });
  }

  renderProfile(); bind(); loadCatalog(false);
})();
