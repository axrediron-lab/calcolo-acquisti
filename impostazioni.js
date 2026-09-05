(function(){
  "use strict";
  var config = window.BUYBOX_CONFIG;
  var settingsApi = window.CalcoloSettings;
  var key = "";
  var revision = 0;
  var margins = [];
  var localMarginCandidates = [];
  var rateMetadata = null;
  try{ key = sessionStorage.getItem(config.accessSessionKey) || ""; }catch(error){}

  function byId(id){ return document.getElementById(id); }
  function escapeHtml(value){ return String(value == null ? "" : value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
  function status(message){ byId("settingsStatus").textContent = message || ""; }
  function accessState(){
    byId("settingsWorkspace").hidden = !key;
    if(!key) window.AppAuth.redirect(false);
  }
  async function api(path, options){
    options = options || {};
    var headers = {"Accept":"application/json","X-App-Key":key};
    if(options.body !== undefined) headers["Content-Type"] = "application/json";
    var response = await fetch(config.apiBase.replace(/\/$/,"") + path, {method:options.method || "GET",headers:headers,cache:"no-store",body:options.body === undefined ? undefined : JSON.stringify(options.body)});
    var payload = null; try{ payload = await response.json(); }catch(error){}
    if(response.status === 401){ key=""; try{sessionStorage.removeItem(config.accessSessionKey);}catch(error){} window.AppAuth.redirect(true); }
    if(!response.ok){ var failure=new Error(payload&&payload.error?payload.error:"Servizio non disponibile"); failure.code=payload&&payload.code; throw failure; }
    return payload;
  }
  function fillForm(values){
    Object.keys(settingsApi.FIELD_DEFAULTS).forEach(function(name){ var input=document.querySelector('[name="'+name+'"]'); if(input) input.value=values[name]; });
    var profiles=settingsApi.mergeDefaults(values).profiles;
    document.querySelector('[name="purchaseImportPerDevice"]').value=profiles.purchases.importPerDevice;
    document.querySelector('[name="purchaseShippingPerDevice"]').value=profiles.purchases.shippingPerDevice;
    updatePurchaseSummary();
    updateRateControls();
  }
  function formValues(){
    var output=settingsApi.load(); Object.keys(settingsApi.FIELD_DEFAULTS).forEach(function(name){ output[name]=document.querySelector('[name="'+name+'"]').value.trim(); });
    output.profiles.purchases.importPerDevice=document.querySelector('[name="purchaseImportPerDevice"]').value.trim();
    output.profiles.purchases.shippingPerDevice=document.querySelector('[name="purchaseShippingPerDevice"]').value.trim();
    return output;
  }
  function decimalValue(value){var number=Number(String(value||"").replace(",","."));return Number.isFinite(number)?number:0;}
  function updatePurchaseSummary(){
    var total=decimalValue(document.querySelector('[name="purchaseImportPerDevice"]').value)+decimalValue(document.querySelector('[name="purchaseShippingPerDevice"]').value);
    byId("purchaseCostSummary").textContent=new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(total);
  }
  function selectSettingsTab(id){
    document.querySelectorAll("[data-settings-tab]").forEach(function(button){var active=button.dataset.settingsTab===id;button.setAttribute("aria-selected",active?"true":"false");});
    document.querySelectorAll("[data-settings-panel]").forEach(function(panel){panel.hidden=panel.dataset.settingsPanel!==id;});
  }
  function formatDate(value){ return value ? new Intl.DateTimeFormat("it-IT",{dateStyle:"short",timeStyle:"short"}).format(new Date(value)) : ""; }
  function formatReferenceDate(value){ if(!value)return "";var parts=String(value).split("-");return parts.length===3?parts.reverse().join("/"):value; }
  function updateRateControls(){
    var automatic=document.querySelector('[name="exchangeRateMode"]').value==="automatic";
    document.querySelector('[name="usdRate"]').readOnly=automatic;
    document.querySelector('[name="sekRate"]').readOnly=automatic;
    byId("refreshExchangeRates").disabled=!automatic;
    renderRateStatus();
  }
  function renderRateStatus(){
    var note=byId("rateStatus");if(!note)return;
    if(document.querySelector('[name="exchangeRateMode"]').value==="manual"){
      note.className="rate-online-status is-manual";
      note.innerHTML="<strong>Gestione manuale</strong><span>I valori inseriti da te restano attivi e non vengono sostituiti dall’aggiornamento automatico.</span>";
      return;
    }
    if(!rateMetadata||rateMetadata.status==="never"){
      note.className="rate-online-status";
      note.innerHTML="<strong>Aggiornamento automatico attivo</strong><span>Il primo controllo BCE sarà eseguito automaticamente oppure premendo Aggiorna cambi ora.</span>";
      return;
    }
    var success=rateMetadata.status==="ok";
    note.className="rate-online-status "+(success?"is-ok":"is-error");
    var reference=rateMetadata.reference_date?" · Cambio del "+formatReferenceDate(rateMetadata.reference_date):"";
    var checked=rateMetadata.last_attempt_at?" · Controllato "+formatDate(rateMetadata.last_attempt_at):"";
    note.innerHTML="<strong>"+(success?"Cambi BCE aggiornati":"Ultimo controllo non riuscito")+"</strong><span>"+(success?"Fonte: "+escapeHtml(rateMetadata.provider||"ECB via Frankfurter")+reference+checked:"È rimasto attivo l’ultimo cambio valido."+checked)+"</span>";
  }
  function readLocalJson(storageKey){ try{var raw=localStorage.getItem(storageKey);return raw?JSON.parse(raw):null;}catch(error){return null;} }
  function localMarginRows(){
    var stored=readLocalJson(config.productMarginCacheKey)||{};
    var catalog=readLocalJson(config.catalogCacheKey)||{};
    var listings=Array.isArray(catalog.results)?catalog.results:[];
    var known=new Set(margins.map(function(item){return item.listing_id;}));
    return Object.keys(stored).filter(function(id){return !known.has(id)&&stored[id]&&!Number(stored[id].revision)&&stored[id].minimum!==undefined&&stored[id].target!==undefined;}).map(function(id){
      var listing=listings.find(function(item){return String(item.id)===id;});
      return {listing_id:id,sku:listing&&listing.sku?listing.sku:(stored[id].sku||"SKU da questo browser"),minimum:stored[id].minimum,target:stored[id].target};
    });
  }
  function renderMargins(){
    byId("overrideCount").textContent=margins.length+" "+(margins.length===1?"personalizzazione":"personalizzazioni");
    byId("productMargins").innerHTML='<a class="secondary-button" href="buybox.html">Apri Monitor BuyBox</a><small>'+(margins.length?"Gestisci i margini direttamente accanto agli articoli interessati.":"Tutti gli articoli utilizzano i margini generali BackMarket.")+'</small>';
  }
  function renderMigration(){
    localMarginCandidates=localMarginRows();
    byId("marginMigration").hidden=!localMarginCandidates.length;
    byId("marginMigrationTitle").textContent=localMarginCandidates.length+" "+(localMarginCandidates.length===1?"personalizzazione trovata":"personalizzazioni trovate")+" su questo PC";
  }
  async function load(){
    status("Caricamento delle impostazioni online…");
    var results=await Promise.all([settingsApi.loadOnline(config.apiBase,key),api("/api/settings/product-margins")]);
    var economic=results[0]; revision=economic.revision; margins=results[1].results||[]; rateMetadata=economic.exchange_rates||null;
    if(economic.exists){
      fillForm(economic.settings); byId("settingsOrigin").textContent="Impostazioni online attive"; byId("settingsUpdated").textContent="Ultimo salvataggio: "+formatDate(economic.updated_at); status("Impostazioni online caricate.");
    }else{
      fillForm(settingsApi.load()); byId("settingsOrigin").textContent="Prima configurazione online"; byId("settingsUpdated").textContent="Sono stati preparati i valori presenti in questo browser. Controllali e salvali online."; status("Archivio pronto: salva una volta per sincronizzare tutti i computer.");
    }
    renderMargins(); renderMigration(); renderRateStatus();
  }

  byId("economicSettings").addEventListener("submit",function(event){
    event.preventDefault(); if(!confirm("Salvare queste impostazioni nell’archivio online? Saranno usate su tutti i computer.")) return;
    var button=byId("saveSettings"); button.disabled=true; status("Salvataggio online in corso…");
    settingsApi.saveOnline(config.apiBase,key,formValues(),revision).then(function(saved){ revision=saved.revision; fillForm(saved.settings); byId("settingsOrigin").textContent="Impostazioni online attive"; byId("settingsUpdated").textContent="Ultimo salvataggio: "+formatDate(saved.updated_at); status("Impostazioni salvate online."); }).catch(function(error){ status(error.message); }).finally(function(){ button.disabled=false; });
  });
  byId("restoreDefaults").addEventListener("click",function(){ if(!confirm("Preparare i valori iniziali? Saranno applicati online soltanto quando premi Salva.")) return; fillForm(settingsApi.defaults()); status("Valori iniziali preparati. Premi Salva impostazioni online per confermare."); });
  document.querySelectorAll("[data-settings-tab]").forEach(function(button){button.addEventListener("click",function(){selectSettingsTab(button.dataset.settingsTab);});});
  document.querySelector('[name="purchaseImportPerDevice"]').addEventListener("input",updatePurchaseSummary);
  document.querySelector('[name="purchaseShippingPerDevice"]').addEventListener("input",updatePurchaseSummary);
  document.querySelector('[name="exchangeRateMode"]').addEventListener("change",updateRateControls);
  byId("refreshExchangeRates").addEventListener("click",function(){
    var button=byId("refreshExchangeRates"); button.disabled=true; byId("rateStatus").className="rate-online-status"; byId("rateStatus").textContent="Aggiornamento dei cambi USD/EUR e SEK/EUR in corso…";
    api("/api/settings/rates/refresh",{method:"POST",body:{confirm:true}}).then(function(result){
      if(result.skipped){rateMetadata=result.exchange_rates||rateMetadata;fillForm(result.settings);status("L’aggiornamento automatico è disattivato dalla modalità manuale.");return;}
      revision=result.revision;rateMetadata=result.exchange_rates||null;fillForm(result.settings);settingsApi.save(result.settings);byId("settingsOrigin").textContent="Impostazioni online attive";byId("settingsUpdated").textContent="Ultimo aggiornamento: "+formatDate(result.updated_at);status("Cambi USD/EUR e SEK/EUR aggiornati online.");
    }).catch(function(error){rateMetadata=Object.assign({},rateMetadata||{},{status:"error",last_attempt_at:new Date().toISOString()});renderRateStatus();status(error.message+" L’ultimo cambio valido è rimasto attivo.");}).finally(function(){updateRateControls();});
  });
  byId("importLocalMargins").addEventListener("click",function(){
    if(!localMarginCandidates.length||!confirm("Trasferire online le personalizzazioni trovate in questo browser?"))return;
    var button=byId("importLocalMargins");button.disabled=true;status("Trasferimento delle personalizzazioni…");
    (async function(){
      var imported=0;
      for(var index=0;index<localMarginCandidates.length;index++){
        var item=localMarginCandidates[index];
        var result=await api("/api/settings/product-margin",{method:"POST",body:{listing_id:item.listing_id,sku:item.sku,minimum:item.minimum,target:item.target,expected_revision:0,confirm:true}});
        margins.push(result.margin);
        var stored=readLocalJson(config.productMarginCacheKey)||{};
        stored[item.listing_id]={minimum:result.margin.minimum_margin,target:result.margin.target_margin,revision:result.margin.revision,sku:result.margin.sku_snapshot};
        try{localStorage.setItem(config.productMarginCacheKey,JSON.stringify(stored));}catch(error){}
        imported+=1;
      }
      renderMargins();renderMigration();status(imported+" personalizzazioni trasferite online.");
    })().catch(function(error){status(error.message);load().catch(function(){});}).finally(function(){button.disabled=false;});
  });

  accessState(); if(key) load().catch(function(error){status(error.message);});
})();
