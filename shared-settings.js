(function(root, factory){
  var api = factory();
  if(typeof module === "object" && module.exports){ module.exports = api; }
  root.CalcoloSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  var STORAGE_KEY = "calcolo_acquisti_settings_v2";
  var LEGACY_KEY = "calcolo_acquisti_completo_v1";
  var EVENT_NAME = "calcolo-settings-changed";
  var DEFAULTS = Object.freeze({
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

  function clone(value){ return JSON.parse(JSON.stringify(value)); }

  function mergeDefaults(value){
    var output = clone(DEFAULTS);
    if(value && typeof value === "object"){
      Object.keys(output).forEach(function(key){
        if(value[key] !== undefined && value[key] !== null){ output[key] = String(value[key]); }
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
      if(Object.prototype.hasOwnProperty.call(DEFAULTS, key)){ settings[key] = String(partial[key]); }
    });
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
    defaults:function(){ return clone(DEFAULTS); },
    load:load,
    save:save,
    update:update,
    reset:reset,
    loadOnline:loadOnline,
    saveOnline:saveOnline
  };
});
