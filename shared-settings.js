(function(root, factory){
  var api = factory();
  if(typeof module === "object" && module.exports){ module.exports = api; }
  root.CalcoloSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  var STORAGE_KEY = "calcolo_acquisti_settings_v2";
  var LEGACY_KEY = "calcolo_acquisti_completo_v1";
  var EVENT_NAME = "calcolo-settings-changed";
  var FIELD_DEFAULTS = Object.freeze({
    fee12:"12",
    fee5:"5",
    investorFee:"1",
    storfundFee:"1,20",
    paymentFee:"1",
    importFee:"0",
    shipping:"16,50",
    shippingItaly:"7,50",
    minimumMargin:"5",
    targetMargin:"7,50",
    usdRate:"0,92",
    sekRate:"0,090",
    exchangeRateMode:"automatic"
  });

  var PROFILE_DEFAULTS = Object.freeze({
    backmarket:Object.freeze({label:"BackMarket",configured:true}),
    purchases:Object.freeze({label:"Acquisti",configured:true,base:"backmarket",importPerDevice:"7",shippingPerDevice:"2"}),
    refurbed:Object.freeze({label:"Refurbed",configured:false})
  });

  function clone(value){ return JSON.parse(JSON.stringify(value)); }

  var DEFAULTS = Object.freeze(Object.assign({},FIELD_DEFAULTS,{profiles:clone(PROFILE_DEFAULTS)}));

  function mergeProfiles(value){
    var output = clone(PROFILE_DEFAULTS);
    var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    ["backmarket","purchases","refurbed"].forEach(function(id){
      if(!source[id] || typeof source[id] !== "object" || Array.isArray(source[id])) return;
      Object.keys(output[id]).forEach(function(key){
        if(source[id][key] === undefined || source[id][key] === null) return;
        output[id][key] = typeof output[id][key] === "boolean" ? source[id][key] === true : String(source[id][key]);
      });
    });
    output.backmarket.configured = true;
    output.purchases.configured = true;
    output.purchases.base = "backmarket";
    return output;
  }

  function mergeDefaults(value){
    var output = clone(DEFAULTS);
    if(value && typeof value === "object"){
      Object.keys(FIELD_DEFAULTS).forEach(function(key){
        if(value[key] !== undefined && value[key] !== null){ output[key] = String(value[key]); }
      });
      output.profiles = mergeProfiles(value.profiles);
    }
    return output;
  }

  function economicFields(settings){
    var normalized = mergeDefaults(settings);
    var output = {};
    Object.keys(FIELD_DEFAULTS).forEach(function(key){ output[key] = normalized[key]; });
    return output;
  }

  function resolveProfile(settings,profileId,sessionOverrides){
    var normalized = mergeDefaults(settings);
    var requested = String(profileId || "backmarket").toLowerCase();
    var id = ["backmarket","purchases","refurbed","custom"].includes(requested) ? requested : "backmarket";
    var output = economicFields(normalized);
    output.profileId = id;
    output.profileLabel = id === "custom" ? "Personalizzato · sessione" : normalized.profiles[id].label;
    output.profileConfigured = id === "custom" ? true : normalized.profiles[id].configured === true;
    output.acquisitionImport = "0";
    output.acquisitionShipping = "0";
    if(id === "purchases"){
      output.acquisitionImport = normalized.profiles.purchases.importPerDevice;
      output.acquisitionShipping = normalized.profiles.purchases.shippingPerDevice;
    }
    if(id === "custom"){
      Object.keys(FIELD_DEFAULTS).forEach(function(key){
        if(sessionOverrides && sessionOverrides[key] !== undefined && sessionOverrides[key] !== null){ output[key] = String(sessionOverrides[key]); }
      });
    }
    return output;
  }

  function readJson(key){
    try{
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }catch(error){ return null; }
  }

  function load(){
    var current = readJson(STORAGE_KEY);
    if(current){ return mergeDefaults(current); }
    var legacy = readJson(LEGACY_KEY);
    var migrated = mergeDefaults(legacy && legacy.settings ? legacy.settings : null);
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)); }catch(error){}
    return migrated;
  }

  function notify(settings){
    if(typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    try{ window.dispatchEvent(new CustomEvent(EVENT_NAME, {detail:clone(settings)})); }catch(error){}
  }

  function save(value){
    var settings = mergeDefaults(value);
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }catch(error){}
    notify(settings);
    return settings;
  }

  function update(partial){
    var settings = load();
    Object.keys(partial || {}).forEach(function(key){
      if(Object.prototype.hasOwnProperty.call(FIELD_DEFAULTS, key)){ settings[key] = String(partial[key]); }
    });
    if(partial && partial.profiles){ settings.profiles = mergeProfiles(partial.profiles); }
    return save(settings);
  }

  function reset(){ return save(DEFAULTS); }

  async function onlineRequest(apiBase, accessKey, options){
    options = options || {};
    var headers = new Headers({"Accept":"application/json","X-App-Key":accessKey || ""});
    if(options.body !== undefined) headers.set("Content-Type","application/json");
    var response = await fetch(String(apiBase || "").replace(/\/$/,"") + "/api/settings", {
      method:options.method || "GET",
      headers:headers,
      cache:"no-store",
      body:options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    var payload = null;
    try{ payload = await response.json(); }catch(error){}
    if(!response.ok){
      var failure = new Error(payload && payload.error ? payload.error : "Archivio impostazioni non disponibile");
      failure.code = payload && payload.code ? payload.code : "SETTINGS_UNAVAILABLE";
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  async function loadOnline(apiBase, accessKey){
    var payload = await onlineRequest(apiBase,accessKey);
    if(payload && payload.exists && payload.settings){ save(payload.settings); }
    return payload;
  }

  async function saveOnline(apiBase, accessKey, value, expectedRevision){
    var settings = mergeDefaults(value);
    var payload = await onlineRequest(apiBase,accessKey,{
      method:"POST",
      body:{settings:settings,expected_revision:expectedRevision,confirm:true}
    });
    if(payload && payload.settings){ save(payload.settings); }
    return payload;
  }

  if(typeof window !== "undefined" && typeof window.addEventListener === "function"){
    window.addEventListener("storage", function(event){
      if(event.key === STORAGE_KEY){ notify(load()); }
    });
  }

  return {
    STORAGE_KEY:STORAGE_KEY,
    EVENT_NAME:EVENT_NAME,
    DEFAULTS:clone(DEFAULTS),
    FIELD_DEFAULTS:clone(FIELD_DEFAULTS),
    PROFILE_DEFAULTS:clone(PROFILE_DEFAULTS),
    defaults:function(){ return clone(DEFAULTS); },
    mergeDefaults:mergeDefaults,
    resolveProfile:resolveProfile,
    load:load,
    save:save,
    update:update,
    reset:reset,
    loadOnline:loadOnline,
    saveOnline:saveOnline
  };
});
