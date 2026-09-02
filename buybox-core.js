(function(root, factory){
  var api = factory();
  if(typeof module === "object" && module.exports){ module.exports = api; }
  root.BuyboxCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  var GRADE_LABELS = {
    PREMIUM:"Premium",
    EXCELLENT:"Eccellente",
    VERY_GOOD:"Ottimo",
    GOOD:"Buono",
    FAIR:"Discreto",
    STALLONE:"Stallone",
    "9":"Premium",
    "0":"Eccellente",
    "1":"Ottimo",
    "2":"Buono",
    "3":"Discreto",
    "4":"Stallone"
  };

  var MARKET_RULES = Object.freeze({
    IT:{name:"Italia",feeKey:"fee12",shippingKey:"shippingItaly",commission:12,currency:"EUR",locale:"it-it"},
    AT:{name:"Austria",feeKey:"fee5",commission:5,currency:"EUR",locale:"de-at"},
    BE:{name:"Belgio",feeKey:"fee12",commission:12,currency:"EUR",locale:"fr-be"},
    ES:{name:"Spagna",feeKey:"fee12",commission:12,currency:"EUR",locale:"es-es"},
    FR:{name:"Francia",feeKey:"fee12",commission:12,currency:"EUR",locale:"fr-fr"},
    FI:{name:"Finlandia",feeKey:"fee5",commission:5,currency:"EUR",locale:"fi-fi"},
    GR:{name:"Grecia",feeKey:"fee12",commission:12,currency:"EUR",locale:"el-gr"},
    IE:{name:"Irlanda",feeKey:"fee5",commission:5,currency:"EUR",locale:"en-ie"},
    NL:{name:"Paesi Bassi",feeKey:"fee5",commission:5,currency:"EUR",locale:"nl-nl"},
    PT:{name:"Portogallo",feeKey:"fee5",commission:5,currency:"EUR",locale:"pt-pt"},
    SE:{name:"Svezia",feeKey:"fee5",commission:5,currency:"SEK",locale:"sv-se"},
    SK:{name:"Slovacchia",feeKey:"fee12",commission:12,currency:"EUR",locale:"sk-sk"}
  });

  function toNumber(value){
    if(value === null || value === undefined || value === "") return 0;
    if(typeof value === "number") return Number.isFinite(value) ? value : 0;
    var normalized = String(value).replace(/\s/g, "").replace(/[€$£]/g, "");
    if(normalized.indexOf(",") >= 0 && normalized.indexOf(".") >= 0){
      if(normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) normalized = normalized.replace(/\./g, "").replace(",", ".");
      else normalized = normalized.replace(/,/g, "");
    }else if(normalized.indexOf(",") >= 0){
      normalized = normalized.replace(",", ".");
    }else if(/^\d{1,3}(?:\.\d{3})+$/.test(normalized) && !/^0\./.test(normalized)){
      normalized = normalized.replace(/\./g, "");
    }
    var number = Number.parseFloat(normalized);
    return Number.isFinite(number) ? number : 0;
  }

  function percent(value){ return toNumber(value) / 100; }

  function numericSettings(settings){
    settings = settings || {};
    return {
      fee12:percent(settings.fee12),
      fee5:percent(settings.fee5),
      investorFee:percent(settings.investorFee),
      storfundFee:percent(settings.storfundFee),
      paymentFee:percent(settings.paymentFee),
      importFee:toNumber(settings.importFee),
      shipping:toNumber(settings.shipping),
      shippingItaly:settings.shippingItaly === undefined ? toNumber(settings.shipping) : toNumber(settings.shippingItaly),
      minimumMargin:percent(settings.minimumMargin),
      targetMargin:percent(settings.targetMargin),
      sekRate:toNumber(settings.sekRate) || 0.09
    };
  }

  function extraRate(settings){
    var value = numericSettings(settings);
    return value.investorFee + value.storfundFee + value.paymentFee;
  }

  function fixedCosts(settings,market){
    var value = numericSettings(settings);
    var rule = marketRule(market);
    var shipping = rule && rule.shippingKey ? value[rule.shippingKey] : value.shipping;
    return value.importFee + shipping;
  }

  function calculateMargin(salePrice, purchasePrice, marketplaceFee, settings, market){
    var sale = toNumber(salePrice);
    var purchase = toNumber(purchasePrice);
    var fee = typeof marketplaceFee === "number" ? marketplaceFee : percent(marketplaceFee);
    var variableCosts = sale * (fee + extraRate(settings));
    var fixed = fixedCosts(settings,market);
    var profit = sale - variableCosts - fixed - purchase;
    return {
      salePrice:sale,
      purchasePrice:purchase,
      variableCosts:variableCosts,
      fixedCosts:fixed,
      profit:profit,
      margin:sale > 0 ? profit / sale : 0
    };
  }

  function suggestedPurchaseForMargin(salePrice, marketplaceFee, desiredMargin, settings, market){
    var sale = toNumber(salePrice);
    var fee = typeof marketplaceFee === "number" ? marketplaceFee : percent(marketplaceFee);
    var target = typeof desiredMargin === "number" ? desiredMargin : percent(desiredMargin);
    return sale * (1 - fee - extraRate(settings) - target) - fixedCosts(settings,market);
  }

  function suggestedPurchase(salePrice, marketplaceFee, settings, market){
    return suggestedPurchaseForMargin(salePrice,marketplaceFee,numericSettings(settings).targetMargin,settings,market);
  }

  function salePriceForMargin(purchasePrice, marketplaceFee, desiredMargin, settings, market){
    var purchase = toNumber(purchasePrice);
    var fee = typeof marketplaceFee === "number" ? marketplaceFee : percent(marketplaceFee);
    var margin = typeof desiredMargin === "number" ? desiredMargin : percent(desiredMargin);
    var denominator = 1 - fee - extraRate(settings) - margin;
    if(denominator <= 0) return null;
    return (purchase + fixedCosts(settings,market)) / denominator;
  }

  function marketRule(market){
    return MARKET_RULES[String(market || "").toUpperCase()] || null;
  }

  function marketFee(settings,market){
    var rule = marketRule(market);
    if(!rule) return null;
    return numericSettings(settings)[rule.feeKey];
  }

  function amountToEuro(value,currency,settings){
    var amount = toNumber(value);
    var code = String(currency || "EUR").toUpperCase();
    if(code === "EUR") return amount;
    if(code === "SEK") return amount * numericSettings(settings).sekRate;
    return null;
  }

  function amountFromEuro(value,currency,settings){
    var amount = toNumber(value);
    var code = String(currency || "EUR").toUpperCase();
    if(code === "EUR") return amount;
    if(code === "SEK"){
      var rate = numericSettings(settings).sekRate;
      return rate > 0 ? amount / rate : null;
    }
    return null;
  }

  function roundPriceUp(value){
    var number = Number(value);
    return Number.isFinite(number) ? Math.ceil((number - 1e-9) * 2) / 2 : null;
  }

  function roundPriceDown(value){
    var number = Number(value);
    return Number.isFinite(number) ? Math.floor((number + 1e-9) * 2) / 2 : null;
  }

  function marketPricePlan(purchasePrice,market,settings,margins){
    var rule = marketRule(market);
    var purchase = toNumber(purchasePrice);
    if(!rule || !purchase) return null;
    var numeric = numericSettings(settings);
    var fee = numeric[rule.feeKey];
    var minimumMargin = margins && margins.minimum !== undefined ? percent(margins.minimum) : numeric.minimumMargin;
    var targetMargin = margins && margins.target !== undefined ? percent(margins.target) : numeric.targetMargin;
    if(minimumMargin < 0 || targetMargin < minimumMargin) return null;
    var minimumEuro = salePriceForMargin(purchase,fee,minimumMargin,settings,market);
    var targetEuro = salePriceForMargin(purchase,fee,targetMargin,settings,market);
    if(minimumEuro === null || targetEuro === null) return null;
    var minimum = roundPriceUp(amountFromEuro(minimumEuro,rule.currency,settings));
    var requestedTarget = roundPriceUp(amountFromEuro(targetEuro,rule.currency,settings));
    var maximumTarget = roundPriceDown(minimum * 1.08);
    var target = Math.max(minimum,Math.min(requestedTarget,maximumTarget));
    return {
      market:String(market).toUpperCase(),
      currency:rule.currency,
      minimum:minimum,
      target:target,
      targetCapped:requestedTarget > maximumTarget,
      minimumMargin:minimumMargin,
      targetMargin:targetMargin
    };
  }

  function formatMoney(value, currency){
    var number = Number(value);
    if(!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("it-IT", {
      style:"currency",
      currency:currency || "EUR"
    }).format(number);
  }

  function formatPercent(value){
    var number = Number(value);
    if(!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("it-IT", {
      style:"percent",
      minimumFractionDigits:2,
      maximumFractionDigits:2
    }).format(number);
  }

  function cleanText(value){ return String(value || "").replace(/\s+/g, " ").trim(); }

  function capacityFromTitle(title){
    var match = cleanText(title).match(/\b(\d+(?:[.,]\d+)?)\s*(GB|GO|TB|TO)\b/i);
    if(!match) return "Non indicata";
    var unit = /T/i.test(match[2]) ? "TB" : "GB";
    return match[1].replace(",", ".") + " " + unit;
  }

  function familyFromTitle(title){
    var clean = cleanText(title);
    var capacity = clean.match(/\b\d+(?:[.,]\d+)?\s*(?:GB|GO|TB|TO)\b/i);
    var family = capacity ? clean.slice(0, capacity.index) : clean.split(" - ")[0];
    family = family.replace(/[\s\-–—]+$/g, "").trim();
    return family || clean || "Prodotto senza titolo";
  }

  function colorFromTitle(title){
    var parts = cleanText(title).split(/\s+-\s+/).map(cleanText).filter(Boolean);
    var ignored = /^(unlocked|sbloccato|sim|dual sim|esim|standard|premium|excellent|eccellente|very good|ottimo|good|buono|fair|discreto)$/i;
    for(var index = parts.length - 1; index > 0; index -= 1){
      var part = parts[index]
        .replace(/\b(?:PREMIUM|EXCELLENT|VERY GOOD|GOOD|FAIR|STALLONE|ECCELLENTE|OTTIMO|BUONO|DISCRETO)\b/ig, "")
        .trim();
      if(part && !ignored.test(part) && !/\b\d+\s*(?:GB|GO|TB|TO)\b/i.test(part)) return part;
    }
    return "Non indicato";
  }

  function brandFromTitle(title){
    var value = cleanText(title);
    if(/iphone|ipad|airpods|apple watch|macbook/i.test(value)) return "Apple";
    if(/galaxy|samsung/i.test(value)) return "Samsung";
    if(/pixel|google/i.test(value)) return "Google";
    if(/xiaomi|redmi|poco/i.test(value)) return "Xiaomi";
    return value.split(" ")[0] || "Altro";
  }

  function normalizeListing(listing){
    listing = listing || {};
    var title = cleanText(listing.title || listing.sku || "Prodotto senza titolo");
    var gradeKey = String(listing.grade !== undefined ? listing.grade : listing.state || "").toUpperCase();
    var newBattery = listing.new_battery === true || String(listing.new_battery).toLowerCase() === "true";
    var battery100 = /\b100\s*%/.test(cleanText([listing.title, listing.sku, listing.comment].join(" ")));
    return {
      id:String(listing.id || listing.listing_id || ""),
      productId:String(listing.product_id || listing.backmarket_id || ""),
      sku:cleanText(listing.sku),
      title:title,
      brand:brandFromTitle(title),
      family:familyFromTitle(title),
      capacity:capacityFromTitle(title),
      color:colorFromTitle(title),
      quality:GRADE_LABELS[gradeKey] || gradeKey || "Non indicata",
      newBattery:newBattery,
      battery100:battery100,
      batteryLabel:newBattery ? "Batteria nuova" : battery100 ? "Batteria 100%" : "Batteria standard",
      currency:listing.currency || "EUR",
      currentPrice:toNumber(listing.price),
      minPrice:listing.min_price == null ? null : toNumber(listing.min_price),
      maxPrice:listing.max_price == null ? null : toNumber(listing.max_price),
      quantity:toNumber(listing.quantity),
      publicationState:listing.publication_state
    };
  }

  function searchableText(listing){
    return [listing.title, listing.sku, listing.brand, listing.family, listing.capacity, listing.color, listing.quality, listing.batteryLabel]
      .join(" ").toLocaleLowerCase("it-IT");
  }

  return {
    GRADE_LABELS:GRADE_LABELS,
    MARKET_RULES:MARKET_RULES,
    toNumber:toNumber,
    numericSettings:numericSettings,
    calculateMargin:calculateMargin,
    suggestedPurchase:suggestedPurchase,
    suggestedPurchaseForMargin:suggestedPurchaseForMargin,
    salePriceForMargin:salePriceForMargin,
    marketRule:marketRule,
    marketFee:marketFee,
    amountToEuro:amountToEuro,
    amountFromEuro:amountFromEuro,
    marketPricePlan:marketPricePlan,
    formatMoney:formatMoney,
    formatPercent:formatPercent,
    normalizeListing:normalizeListing,
    searchableText:searchableText
  };
});
