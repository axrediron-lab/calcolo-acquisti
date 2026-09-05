(function(){
  "use strict";
  var config=window.BUYBOX_CONFIG;
  var settingsApi=window.CalcoloSettings;
  var core=window.BuyboxCore;
  var SESSION_KEY="mobile_calculator_session_v1";
  var CUSTOM_FIELDS=["fee12","fee5","investorFee","storfundFee","paymentFee","importFee","shipping","shippingItaly","minimumMargin","targetMargin"];
  var state={settings:settingsApi.load(),profileId:"backmarket",custom:{},customFromSession:false,profile:null};

  function byId(id){return document.getElementById(id);}
  function accessKey(){try{return sessionStorage.getItem(config.accessSessionKey)||"";}catch(error){return "";}}
  function sessionData(){try{var raw=sessionStorage.getItem(SESSION_KEY);return raw?JSON.parse(raw):{};}catch(error){return {};}}
  function saveSession(){
    try{sessionStorage.setItem(SESSION_KEY,JSON.stringify({profileId:state.profileId,custom:state.custom,customDirty:state.customFromSession,salePrice:byId("salePrice").value,purchasePrice:byId("purchasePrice").value,usdPrice:byId("usdPrice").value}));}catch(error){}
  }
  function money(value){return Number.isFinite(value)?core.formatMoney(value,"EUR"):"—";}
  function percent(value){return Number.isFinite(value)?core.formatPercent(value):"—";}
  function decimal(value){return new Intl.NumberFormat("it-IT",{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);}
  function description(id){
    if(id==="purchases")return "Regole BackMarket con i costi di importazione e spedizione in ingresso per ogni dispositivo.";
    if(id==="refurbed")return "Regole Refurbed condivise dalle impostazioni online.";
    if(id==="custom")return "Copia temporanea del profilo BackMarket, modificabile liberamente senza cambiare le impostazioni online.";
    return "Commissioni, costi di vendita e margini condivisi del profilo BackMarket.";
  }
  function profileValue(name){return state.profile&&state.profile[name]!==undefined?state.profile[name]:"0";}
  function ruleRow(label,value,suffix){return "<div><dt>"+label+"</dt><dd>"+value+(suffix||"")+"</dd></div>";}
  function renderRules(){
    var numeric=core.numericSettings(state.profile);
    var breakdown=core.fixedCostBreakdown(state.profile,"FR");
    byId("profileName").textContent=state.profile.profileLabel;
    byId("profileDescription").textContent=description(state.profileId);
    byId("profileChips").innerHTML=[
      "Standard "+decimal(numeric.fee12*100)+"%",
      "Ridotti "+decimal(numeric.fee5*100)+"%",
      "Fissi "+money(breakdown.total),
      "Obiettivo "+decimal(numeric.targetMargin*100)+"%"
    ].map(function(value){return "<span>"+value+"</span>";}).join("");
    byId("profileRules").innerHTML=[
      ruleRow("Commissione mercati standard",decimal(numeric.fee12*100),"%"),
      ruleRow("Commissione mercati ridotti",decimal(numeric.fee5*100),"%"),
      ruleRow("Fee aggiuntive",decimal((numeric.investorFee+numeric.storfundFee+numeric.paymentFee)*100),"%"),
      ruleRow("Altri costi fissi",money(breakdown.baseImport),""),
      ruleRow("Spedizione vendita",money(breakdown.marketplaceShipping),""),
      ruleRow("Importazione acquisto",money(breakdown.acquisitionImport),""),
      ruleRow("Spedizione acquisto",money(breakdown.acquisitionShipping),""),
      ruleRow("Margine minimo",decimal(numeric.minimumMargin*100),"%"),
      ruleRow("Margine obiettivo",decimal(numeric.targetMargin*100),"%")
    ].join("");
    byId("fee12Label").textContent=decimal(numeric.fee12*100)+"%";
    byId("fee5Label").textContent=decimal(numeric.fee5*100)+"%";
    var usdRate=core.toNumber(profileValue("usdRate"));
    byId("usdRateLabel").textContent=usdRate>0?"1 USD = "+usdRate.toFixed(4).replace(".",",")+" EUR":"Cambio non disponibile";
  }
  function prepareCustom(){
    if(Object.keys(state.custom).length)return;
    var base=settingsApi.resolveProfile(state.settings,"backmarket");
    CUSTOM_FIELDS.forEach(function(name){state.custom[name]=base[name];});
  }
  function fillCustom(){
    prepareCustom();
    CUSTOM_FIELDS.forEach(function(name){var input=document.querySelector('#customProfilePanel [name="'+name+'"]');if(input)input.value=state.custom[name];});
  }
  function selectProfile(id){
    var profileId=["backmarket","purchases","refurbed","custom"].includes(id)?id:"backmarket";
    if(profileId==="refurbed"&&!state.settings.profiles.refurbed.configured)return;
    state.profileId=profileId;
    if(profileId==="custom"){prepareCustom();fillCustom();}
    state.profile=settingsApi.resolveProfile(state.settings,profileId,state.custom);
    document.querySelectorAll("[data-profile]").forEach(function(button){button.setAttribute("aria-pressed",button.dataset.profile===profileId?"true":"false");});
    byId("customProfilePanel").hidden=profileId!=="custom";
    renderRules();calculate();convert();saveSession();
  }
  function resultState(node,margin,numeric){
    node.classList.remove("is-good","is-warning","is-bad");
    if(!Number.isFinite(margin))return;
    node.classList.add(margin>=numeric.targetMargin?"is-good":margin>=numeric.minimumMargin?"is-warning":"is-bad");
  }
  function renderMarket(suffix,market,sale,purchase){
    var numeric=core.numericSettings(state.profile);
    var fee=core.marketFee(state.profile,market);
    var maximum=sale>0?core.suggestedPurchaseForMargin(sale,fee,numeric.targetMargin,state.profile,market):null;
    byId("maximum"+suffix).textContent=money(maximum);
    var marginNode=byId("margin"+suffix);
    var profitNode=byId("profit"+suffix);
    var card=document.querySelector('[data-result="'+suffix+'"]');
    if(sale<=0||purchase<=0){marginNode.textContent="—";profitNode.textContent="—";resultState(card,NaN,numeric);return;}
    var result=core.calculateMargin(sale,purchase,fee,state.profile,market);
    marginNode.textContent=percent(result.margin);
    profitNode.textContent=money(result.profit);
    resultState(card,result.margin,numeric);
  }
  function calculate(){
    if(!state.profile)return;
    var sale=core.toNumber(byId("salePrice").value);
    var purchase=core.toNumber(byId("purchasePrice").value);
    renderMarket("12","FR",sale,purchase);
    renderMarket("5","AT",sale,purchase);
    saveSession();
  }
  function convert(){
    if(!state.profile)return;
    var usd=core.toNumber(byId("usdPrice").value);
    var rate=core.toNumber(profileValue("usdRate"));
    var converted=usd>0&&rate>0?usd*rate:null;
    byId("eurResult").textContent=money(converted);
    byId("useConvertedPurchase").disabled=!Number.isFinite(converted);
    saveSession();
  }
  function bind(){
    document.querySelectorAll("[data-profile]").forEach(function(button){button.addEventListener("click",function(){selectProfile(button.dataset.profile);});});
    ["salePrice","purchasePrice"].forEach(function(id){byId(id).addEventListener("input",calculate);});
    byId("usdPrice").addEventListener("input",convert);
    document.querySelectorAll("#customProfilePanel input").forEach(function(input){input.addEventListener("input",function(){state.customFromSession=true;state.custom[input.name]=input.value;state.profile=settingsApi.resolveProfile(state.settings,"custom",state.custom);renderRules();calculate();convert();});});
    byId("useConvertedPurchase").addEventListener("click",function(){
      var converted=core.toNumber(byId("usdPrice").value)*core.toNumber(profileValue("usdRate"));
      if(converted<=0)return;
      byId("purchasePrice").value=converted.toFixed(2).replace(".",",");calculate();
    });
    byId("resetCalculator").addEventListener("click",function(){
      if(!confirm("Pulire i valori del calcolatore e il profilo personalizzato di questa sessione?"))return;
      try{sessionStorage.removeItem(SESSION_KEY);}catch(error){}
      state.custom={};state.customFromSession=false;byId("salePrice").value="";byId("purchasePrice").value="";byId("usdPrice").value="";selectProfile("backmarket");
    });
  }
  async function loadOnline(){
    try{
      var payload=await settingsApi.loadOnline(config.apiBase,accessKey());
      if(payload&&payload.settings){state.settings=payload.settings;if(state.profileId==="custom"&&!state.customFromSession)state.custom={};}
      byId("profileOrigin").textContent="Impostazioni online";
      byId("mobileStatus").textContent="Regole online aggiornate.";
    }catch(error){
      if(error.status===401||error.code==="ACCESS_REQUIRED"){window.AppAuth.redirect(true);return;}
      byId("profileOrigin").textContent="Ultima copia salvata";
      byId("mobileStatus").textContent="Archivio non raggiungibile: uso l’ultima configurazione disponibile.";
    }
    var refurbedButton=document.querySelector('[data-profile="refurbed"]');
    refurbedButton.disabled=!state.settings.profiles.refurbed.configured;
    refurbedButton.querySelector("span").textContent=refurbedButton.disabled?"Da configurare":"Configurato";
    selectProfile(state.profileId);
  }
  function start(){
    var saved=sessionData();
    if(saved.profileId)state.profileId=saved.profileId;
    if(saved.custom&&typeof saved.custom==="object"&&Object.keys(saved.custom).length){state.custom=saved.custom;state.customFromSession=saved.customDirty===true;}
    byId("salePrice").value=saved.salePrice||"";
    byId("purchasePrice").value=saved.purchasePrice||"";
    byId("usdPrice").value=saved.usdPrice||"";
    bind();selectProfile(state.profileId);loadOnline();
  }
  start();
})();
