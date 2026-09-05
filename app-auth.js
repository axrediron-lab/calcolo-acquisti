(function(){
  "use strict";
  var config=window.BUYBOX_CONFIG;
  var byId=function(id){return document.getElementById(id);};
  function key(){try{return sessionStorage.getItem(config.accessSessionKey)||"";}catch(error){return "";}}
  function safeReturn(){
    var value=new URLSearchParams(location.search).get("return")||"";
    return /^[a-z0-9-]+\.html(?:\?[^#]*)?(?:#.*)?$/i.test(value)&&!value.toLowerCase().startsWith("index.html")?value:"";
  }
  function show(loggedIn){
    byId("loginView").hidden=loggedIn;
    byId("homeView").hidden=!loggedIn;
    document.title=loggedIn?config.appName:"Accedi · "+config.appName;
  }
  async function verify(value){
    var response=await fetch(config.apiBase+"/api/purchases/status",{headers:{"X-App-Key":value,"Accept":"application/json"},cache:"no-store",credentials:"omit"});
    return response.ok;
  }
  async function start(){
    var existing=key();
    if(!existing){show(false);return;}
    show(true);
    if(await verify(existing)){
      var target=safeReturn(); if(target) location.replace(target);
    }else{
      try{sessionStorage.removeItem(config.accessSessionKey);}catch(error){}
      show(false);
    }
  }
  byId("accessLogin").addEventListener("submit",async function(event){
    event.preventDefault();
    var input=byId("homeAccessKey"),button=byId("loginSubmit"),error=byId("homeLoginError");
    var value=input.value.trim(); if(!value)return;
    button.disabled=true; error.hidden=true;
    try{
      if(!await verify(value)) throw new Error("Codice non valido");
      sessionStorage.setItem(config.accessSessionKey,value); input.value="";
      var target=safeReturn(); if(target) location.replace(target); else show(true);
    }catch(failure){ error.hidden=false; }
    finally{ button.disabled=false; }
  });
  byId("appLogout").addEventListener("click",function(){
    try{sessionStorage.removeItem(config.accessSessionKey);}catch(error){}
    history.replaceState(null,"",location.pathname); show(false); byId("homeAccessKey").focus();
  });
  start().catch(function(){show(false);});
})();
