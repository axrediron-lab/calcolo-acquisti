(function () {
  "use strict";
  var config = window.BUYBOX_CONFIG, core = window.BuyboxCore, key = "", documentKey = new URLSearchParams(location.search).get("key") || "", work = null, live = new Map(), boxes = new Map(), busy = false;
  var byId = id => document.getElementById(id);
  var esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  var money = cents => (cents / 100).toLocaleString("it-IT", {style:"currency",currency:"EUR"});
  try { key = sessionStorage.getItem(config.accessSessionKey) || ""; } catch (_) {}
  function status(text) { byId("workStatus").textContent = text; }
  function accessState() { var dialog=byId("workLoginDialog"); byId("workWorkspace").hidden=!key; if(key){if(dialog.open)dialog.close();}else if(!dialog.open){dialog.showModal();setTimeout(()=>byId("workKey").focus(),0);} }
  async function api(path, body) {
    var response = await fetch(config.apiBase + path,{method:body===undefined?"GET":"POST",headers:{"X-App-Key":key,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store",credentials:"omit"});
    var data={}; try{data=await response.json();}catch(_){}
    if(response.status===401){key="";try{sessionStorage.removeItem(config.accessSessionKey);}catch(_){} accessState();throw new Error("Codice di accesso richiesto");}
    if(!response.ok)throw new Error(data.error||"Operazione non riuscita"); return data;
  }
  function boxHtml(payload) {
    var competitors=Array.isArray(payload?.competitors)?payload.competitors:[];
    if(!competitors.length)return '<span class="work-muted">Nessuna BuyBox disponibile</span>';
    return competitors.map(c=>{var v=c.winner_price, amount=v&&v.amount!==undefined?v.amount:v, currency=v&&v.currency?v.currency:"EUR";return '<span class="setting-chip">'+esc(String(c.market||"—").toUpperCase())+' · '+esc(core.formatMoney(Number(amount),currency))+'</span>';}).join("");
  }
  function calculated(item, mode) {
    var listing=live.get(item.listing_id), current=Number(listing?.quantity), previous=item.cost;
    if(!Number.isSafeInteger(current))return null;
    if(item.processing)return {current,old:item.processing.previous_quantity,average:item.processing.new_average_cost_cents,target:mode==="manual"?current:current+item.incoming_quantity};
    var old=mode==="manual"?current-item.incoming_quantity:current;
    if(previous&&old<0)return {error:"La quantità attuale è inferiore a quella ricevuta."};
    var average=previous?Math.round((old*previous.average_cost_cents+item.incoming_total_cents)/(old+item.incoming_quantity)):item.incoming_unit_cost_cents;
    return {current,old:previous?old:null,average,target:mode==="manual"?current:current+item.incoming_quantity};
  }
  function processingLabel(value){return {pending:"Costo salvato · quantità in sospeso",manual:"Costo salvato · quantità gestita manualmente",applying:"Aggiornamento quantità da completare",automatic:"Costo e quantità aggiornati"}[value]||"";}
  function render() {
    byId("workHeading").innerHTML='<p class="eyebrow">Documento Ready</p><h2>'+esc(work.document.document_number)+' · '+esc(work.document.document_date)+'</h2><p>Solo gli articoli presenti in questo documento. Il costo iniziale non viene mediato; la media parte dagli acquisti successivi.</p>';
    byId("workItems").innerHTML=work.items.map((item,index)=>{
      var listing=live.get(item.listing_id), mode="prices_only", calc=calculated(item,mode), blocked=item.earlier_document&&!item.processing, done=item.processing&&item.processing.quantity_status!=="pending"&&item.processing.quantity_status!=="applying";
      var saved=item.processing?'<div class="work-result"><strong>'+esc(processingLabel(item.processing.quantity_status))+'</strong><span>Costo medio registrato: '+esc(money(item.processing.new_average_cost_cents))+'</span>'+(item.processing.quantity_status==="automatic"?'<span>Quantità Back Market: '+item.processing.target_quantity+'</span>':'')+'</div>':'';
      return '<article class="purchases-panel work-card" data-index="'+index+'"><div class="work-card-head"><div><span class="eyebrow">'+esc(item.ready_codes.join(" · "))+'</span><h2>'+esc(item.description)+'</h2><p>'+esc(listing?.sku||item.sku_snapshot)+'</p></div><a class="secondary-button" href="buybox.html?listing='+encodeURIComponent(item.listing_id)+'">Prezzi e BuyBox →</a></div><div class="work-stats"><div><small>Ricevuti</small><strong>'+item.incoming_quantity+'</strong></div><div><small>Costo ordine</small><strong>'+esc(money(item.incoming_unit_cost_cents))+'</strong></div><div><small>Costo precedente</small><strong>'+(item.cost?esc(money(item.cost.average_cost_cents)):"Nessuno")+'</strong></div><div><small>Quantità Back Market</small><strong>'+esc(listing?listing.quantity:"Lettura…")+'</strong></div></div><div class="work-buyboxes"><small>BuyBox rilevate</small>'+boxHtml(boxes.get(item.listing_id))+'</div>'+saved+(blocked?'<div class="work-blocked"><strong>Prima lavora il documento '+esc(item.earlier_document.document_number)+'</strong><a href="lavorazione.html?key='+encodeURIComponent(item.earlier_document.document_key)+'">Apri il documento precedente →</a></div>':!done?'<div class="work-choice"><label for="mode-'+index+'">Gestione di questo articolo</label><select id="mode-'+index+'" data-mode-select="'+index+'">'+(item.processing?.quantity_status==="pending"?'':'<option value="prices_only">Usa il costo e lavora sui prezzi; quantità in sospeso</option>')+'<option value="manual">Quantità già aggiornata manualmente</option><option value="automatic">Aggiorna quantità automaticamente</option></select><div class="work-preview" data-preview="'+index+'">'+(calc?previewText(item,calc,mode):"Lettura quantità…")+'</div><button type="button" data-process="'+index+'">Conferma questa scelta</button></div>':'')+'</article>';
    }).join("");
  }
  function previewText(item,calc,mode){if(calc.error)return '<span class="form-error">'+esc(calc.error)+'</span>';var first=!item.cost;var quantity=mode==="manual"?'Nessun invio: confermerai che '+calc.current+' include già l’ordine.':mode==="automatic"?'Quantità proposta: '+calc.current+' + '+item.incoming_quantity+' = '+calc.target+'.':'Nessun invio quantità; resterà in sospeso.';return '<strong>'+(first?'Costo iniziale':'Nuovo costo medio')+': '+esc(money(calc.average))+'</strong><span>'+esc(quantity)+'</span>';}
  async function load() {
    if(!documentKey){status("Documento non indicato. Torna ad Acquisti e scegli Lavora.");return;}
    status("Lettura documento, quantità e BuyBox…"); work=await api("/api/purchases/work?key="+encodeURIComponent(documentKey));
    await Promise.all(work.items.map(async item=>{try{var d=await api("/api/listings/"+encodeURIComponent(item.listing_id)+"?market=IT");live.set(item.listing_id,core.normalizeListing(d.listing));}catch(error){live.set(item.listing_id,{sku:item.sku_snapshot,quantity:null,error:error.message});}try{boxes.set(item.listing_id,await api("/api/backbox/"+encodeURIComponent(item.listing_id)));}catch(_){boxes.set(item.listing_id,{competitors:[]});}}));
    render();status("Controllo pronto. Nessuna modifica effettuata.");
  }
  byId("workLogin").addEventListener("submit",event=>{event.preventDefault();if(busy)return;busy=true;(async()=>{key=byId("workKey").value.trim();byId("workKey").value="";byId("workLoginError").hidden=true;try{await api("/api/purchases/status");sessionStorage.setItem(config.accessSessionKey,key);accessState();await load();}catch(error){byId("workLoginError").textContent=error.message;byId("workLoginError").hidden=false;}})().finally(()=>busy=false);});
  document.addEventListener("change",event=>{var select=event.target.closest("[data-mode-select]");if(!select)return;var index=Number(select.dataset.modeSelect),item=work.items[index],calc=calculated(item,select.value);document.querySelector('[data-preview="'+index+'"]').innerHTML=calc?previewText(item,calc,select.value):"Quantità non disponibile.";});
  document.addEventListener("click",event=>{var button=event.target.closest("[data-process]");if(!button||busy)return;var index=Number(button.dataset.process),item=work.items[index],mode=byId("mode-"+index).value,calc=calculated(item,mode);if(!calc||calc.error)return;var warning=mode==="automatic"?'Verrà inviata a Back Market la quantità '+calc.target+'.':mode==="manual"?'Non verrà inviata alcuna quantità. Confermi che quella attuale comprende già questo ordine?':'La quantità non verrà inviata e resterà in sospeso.';var costMessage=item.processing?'Il costo è già registrato a '+money(calc.average)+'.':(item.cost?'Registrare il nuovo costo medio ':'Registrare il costo iniziale ')+money(calc.average)+'?';if(!confirm(costMessage+'\n\n'+warning+'\nI prezzi restano separati e non saranno inviati.'))return;busy=true;button.disabled=true;status("Registrazione in corso…");api("/api/purchases/process",{document_key:documentKey,listing_id:item.listing_id,mode,expected_bm_quantity:calc.current,confirm:true}).then(load).catch(error=>status(error.message)).finally(()=>busy=false);});
  accessState();if(key)load().catch(error=>status(error.message));
}());
