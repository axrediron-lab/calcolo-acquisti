(function(){
  "use strict";
  var config=window.BUYBOX_CONFIG||{};
  function currentReturn(){
    var file=location.pathname.split("/").pop()||"index.html";
    return file+location.search+location.hash;
  }
  function redirect(clear){
    if(clear){ try{sessionStorage.removeItem(config.accessSessionKey);}catch(error){} }
    var target="index.html?return="+encodeURIComponent(currentReturn());
    if(location.pathname.endsWith("/index.html")||location.pathname.endsWith("/")) return;
    location.replace(target);
  }
  window.AppAuth=Object.freeze({redirect:redirect});
  var key="";
  try{ key=sessionStorage.getItem(config.accessSessionKey)||""; }catch(error){}
  if(!key) redirect(false);
})();
