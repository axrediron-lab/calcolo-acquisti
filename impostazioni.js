(function(){
  "use strict";
  var config = window.BUYBOX_CONFIG;
  var settingsApi = window.CalcoloSettings;
  var key = "";
  var revision = 0;
  var margins = [];
  var localMarginCandidates = [];
  try{ key = sessionStorage.getItem(config.accessSessionKey) || ""; }catch(error){}

  function byId(id){ return document.getElementById(id); }
  function escapeHtml(value){ return String(value == null ? "" : value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
  function status(message){ byId("settingsStatus").textContent = message || ""; }
  function accessState(){
    var dialog = byId("settingsLoginDialog");
    byId("settingsWorkspace").hidden = !key;
    if(key){ if(dialog.open) dialog.close(); }
    else if(!dialog.open){ dialog.showModal(); setTimeout(function(){ byId("settingsKey").focus(); },0); }
  }
  async function api(path, options){
    options = options || {};
    var headers = {"Accept":"application/json","X-App-Key":key};
    if(options.body !== undefined) headers["Content-Type"] = "application/json";
    var response = await fetch(config.apiBase.replace(/\/$/,"") + path, {method:options.method || "GET",headers:headers,cache:"no-store",body:options.body === undefined ? undefined : JSON.stringify(options.body)});
    var payload = null; try{ payload = await response.json(); }catch(error){}
    if(response.status === 401){ key=""; try{sessionStorage.removeItem(config.accessSessionKey);}catch(error){} accessState(); }
    if(!response.ok){ var failure=new Error(payload&&payload.error?payload.error:"Servizio non disponibile"); failure.code=payload&&payload.code; throw failure; }
    return payload;
  }
  function fillForm(values){
    Object.keys(settingsApi.DEFAULTS).forEach(function(name){ var input=document.querySelector('[name="'+name+'"]'); if(input) input.value=values[name]; });
  }
  function formValues(){
    var output={}; Object.keys(settingsApi.DEFAULTS).forEach(function(name){ output[name]=document.querySelector('[name="'+name+'"]').value.trim(); }); return output;
  }
  function formatDate(value){ return value ? new Intl.DateTimeFormat("it-IT",{dateStyle:"short",timeStyle:"short"}).format(new Date(value)) : ""; }
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
    if(!margins.length){ byId("productMargins").innerHTML='<div class="settings-empty"><strong>Nessun margine personalizzato</strong><p>Tutti gli articoli usano i margini generali.</p></div>'; return; }
    byId("productMargins").innerHTML='<div class="purchases-table-wrap"><table><thead><tr><th>SKU Back Market</th><th>Margine minimo</th><th>Margine obiettivo</th><th>Ultima modifica</th><th>Azioni</th></tr></thead><tbody>'+margins.map(function(item){return '<tr data-margin-row="'+escapeHtml(item.listing_id)+'"><td><strong>'+escapeHtml(item.sku_snapshot)+'</strong><small>'+escapeHtml(item.listing_id)+'</small></td><td><input class="override-input" data-margin-minimum inputmode="decimal" value="'+escapeHtml(item.minimum_margin)+'" aria-label="Margine minimo"></td><td><input class="override-input" data-margin-target inputmode="decimal" value="'+escapeHtml(item.target_margin)+'" aria-label="Margine obiettivo"></td><td>'+escapeHtml(formatDate(item.updated_at))+'</td><td><button type="button" data-save-margin="'+escapeHtml(item.listing_id)+'">Salva</button><button class="secondary" type="button" data-remove-margin="'+escapeHtml(item.listing_id)+'">Usa valori generali</button></td></tr>';}).join("")+'</tbody></table></div>';
  }
  function renderMigration(){
    localMarginCandidates=localMarginRows();
    byId("marginMigration").hidden=!localMarginCandidates.length;
    byId("marginMigrationTitle").textContent=localMarginCandidates.length+" "+(localMarginCandidates.length===1?"personalizzazione trovata":"personalizzazioni trovate")+" su questo PC";
  }
  async function load(){
    status("Caricamento delle impostazioni online…");
    var results=await Promise.all([settingsApi.loadOnline(config.apiBase,key),api("/api/settings/product-margins")]);
    var economic=results[0]; revision=economic.revision; margins=results[1].results||[];
    if(economic.exists){
      fillForm(economic.settings); byId("settingsOrigin").textContent="Impostazioni online attive"; byId("settingsUpdated").textContent="Ultimo salvataggio: "+formatDate(economic.updated_at); status("Impostazioni online caricate.");
    }else{
      fillForm(settingsApi.load()); byId("settingsOrigin").textContent="Prima configurazione online"; byId("settingsUpdated").textContent="Sono stati preparati i valori presenti in questo browser. Controllali e salvali online."; status("Archivio pronto: salva una volta per sincronizzare tutti i computer.");
    }
    renderMargins(); renderMigration();
  }

  byId("settingsLogin").addEventListener("submit",function(event){
    event.preventDefault(); key=byId("settingsKey").value.trim(); byId("settingsKey").value=""; byId("settingsLoginError").hidden=true;
    load().then(function(){ sessionStorage.setItem(config.accessSessionKey,key); accessState(); }).catch(function(error){ key=""; byId("settingsLoginError").textContent=error.message; byId("settingsLoginError").hidden=false; accessState(); });
  });
  byId("economicSettings").addEventListener("submit",function(event){
    event.preventDefault(); if(!confirm("Salvare queste impostazioni nell’archivio online? Saranno usate su tutti i computer.")) return;
    var button=byId("saveSettings"); button.disabled=true; status("Salvataggio online in corso…");
    settingsApi.saveOnline(config.apiBase,key,formValues(),revision).then(function(saved){ revision=saved.revision; fillForm(saved.settings); byId("settingsOrigin").textContent="Impostazioni online attive"; byId("settingsUpdated").textContent="Ultimo salvataggio: "+formatDate(saved.updated_at); status("Impostazioni salvate online."); }).catch(function(error){ status(error.message); }).finally(function(){ button.disabled=false; });
  });
  byId("restoreDefaults").addEventListener("click",function(){ if(!confirm("Preparare i valori iniziali? Saranno applicati online soltanto quando premi Salva.")) return; fillForm(settingsApi.defaults()); status("Valori iniziali preparati. Premi Salva impostazioni online per confermare."); });
  byId("refreshUsdRate").addEventListener("click",function(){
    var button=byId("refreshUsdRate"),note=byId("rateStatus"); button.disabled=true; note.textContent="Aggiornamento cambio USD/EUR…";
    fetch("https://api.frankfurter.dev/v2/rate/USD/EUR").then(function(response){if(!response.ok)throw new Error();return response.json();}).then(function(data){if(!data||!Number.isFinite(Number(data.rate)))throw new Error();document.querySelector('[name="usdRate"]').value=Number(data.rate).toFixed(4).replace(".",",");note.textContent="Cambio aggiornato al "+String(data.date||"oggi").split("-").reverse().join("/")+". Premi Salva per renderlo attivo online.";}).catch(function(){note.textContent="Cambio non disponibile. Il valore precedente non è stato modificato.";}).finally(function(){button.disabled=false;});
  });
  byId("productMargins").addEventListener("click",function(event){
    var saveButton=event.target.closest("[data-save-margin]");
    if(saveButton){
      var saveId=saveButton.dataset.saveMargin,saveItem=margins.find(function(row){return row.listing_id===saveId;}),row=saveButton.closest("[data-margin-row]");if(!saveItem||!row)return;
      saveButton.disabled=true;status("Salvataggio del margine personalizzato…");
      api("/api/settings/product-margin",{method:"POST",body:{listing_id:saveId,sku:saveItem.sku_snapshot,minimum:row.querySelector("[data-margin-minimum]").value.trim(),target:row.querySelector("[data-margin-target]").value.trim(),expected_revision:saveItem.revision,confirm:true}}).then(function(result){
        margins=margins.map(function(item){return item.listing_id===saveId?result.margin:item;});
        var stored=readLocalJson(config.productMarginCacheKey)||{};stored[saveId]={minimum:result.margin.minimum_margin,target:result.margin.target_margin,revision:result.margin.revision,sku:result.margin.sku_snapshot};try{localStorage.setItem(config.productMarginCacheKey,JSON.stringify(stored));}catch(error){}
        renderMargins();renderMigration();status("Margine personalizzato salvato online.");
      }).catch(function(error){status(error.message);saveButton.disabled=false;});return;
    }
    var button=event.target.closest("[data-remove-margin]"); if(!button)return; var listingId=button.dataset.removeMargin,item=margins.find(function(row){return row.listing_id===listingId;}); if(!item)return;
    if(!confirm("Ripristinare per "+item.sku_snapshot+" i margini generali?"))return; button.disabled=true; status("Aggiornamento margine…");
    api("/api/settings/product-margin",{method:"POST",body:{listing_id:listingId,expected_revision:item.revision,remove:true,confirm:true}}).then(function(){
      margins=margins.filter(function(row){return row.listing_id!==listingId;});
      var stored=readLocalJson(config.productMarginCacheKey)||{};delete stored[listingId];try{localStorage.setItem(config.productMarginCacheKey,JSON.stringify(stored));}catch(error){}
      renderMargins();renderMigration();status("L’articolo usa nuovamente i margini generali.");
    }).catch(function(error){status(error.message);button.disabled=false;});
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
