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

  function toNumber(value){
    if(value === null || value === undefined || value === "") return 0;
    var normalized = String(value)
      .replace(/\s/g, "")
      .replace(/[€$£]/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".");
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
      minimumMargin:percent(settings.minimumMargin),
      targetMargin:percent(settings.targetMargin)
    };
  }

  function extraRate(settings){
    var value = numericSettings(settings);
    return value.investorFee + value.storfundFee + value.paymentFee;
  }

  function fixedCosts(settings){
    var value = numericSettings(settings);
    return value.importFee + value.shipping;
  }

  function calculateMargin(salePrice, purchasePrice, marketplaceFee, settings){
    var sale = toNumber(salePrice);
    var purchase = toNumber(purchasePrice);
    var fee = typeof marketplaceFee === "number" ? marketplaceFee : percent(marketplaceFee);
    var variableCosts = sale * (fee + extraRate(settings));
    var fixed = fixedCosts(settings);
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

  function suggestedPurchase(salePrice, marketplaceFee, settings){
    var sale = toNumber(salePrice);
    var fee = typeof marketplaceFee === "number" ? marketplaceFee : percent(marketplaceFee);
    var target = numericSettings(settings).targetMargin;
    return sale * (1 - fee - extraRate(settings) - target) - fixedCosts(settings);
  }

  function salePriceForMargin(purchasePrice, marketplaceFee, desiredMargin, settings){
    var purchase = toNumber(purchasePrice);
    var fee = typeof marketplaceFee === "number" ? marketplaceFee : percent(marketplaceFee);
    var margin = typeof desiredMargin === "number" ? desiredMargin : percent(desiredMargin);
    var denominator = 1 - fee - extraRate(settings) - margin;
    if(denominator <= 0) return null;
    return (purchase + fixedCosts(settings)) / denominator;
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
      batteryLabel:newBattery ? "Batteria nuova" : "Batteria standard",
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
    toNumber:toNumber,
    numericSettings:numericSettings,
    calculateMargin:calculateMargin,
    suggestedPurchase:suggestedPurchase,
    salePriceForMargin:salePriceForMargin,
    formatMoney:formatMoney,
    formatPercent:formatPercent,
    normalizeListing:normalizeListing,
    searchableText:searchableText
  };
});
