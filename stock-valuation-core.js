(function(root, factory){
  var api = factory(typeof module === "object" && module.exports ? require("./buybox-core.js") : root.BuyboxCore);
  if(typeof module === "object" && module.exports){ module.exports = api; }
  root.StockValuationCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(core){
  "use strict";

  var GROUP_12 = ["IT","BE","ES","FR","GR","SK"];
  var GROUP_5 = ["AT","FI","IE","NL","PT","SE"];

  function finitePositive(value){ return Number.isFinite(value) && value > 0; }
  function mean(values){
    var clean = (values || []).filter(Number.isFinite);
    return clean.length ? clean.reduce(function(total,value){ return total + value; },0) / clean.length : null;
  }
  function median(values){
    var clean = (values || []).filter(Number.isFinite).sort(function(a,b){ return a-b; });
    if(!clean.length) return null;
    var middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle-1] + clean[middle]) / 2;
  }
  function unique(values){ return Array.from(new Set(values)); }

  function groupFamilies(listings){
    var groups = {};
    (listings || []).filter(function(listing){ return listing && listing.id && listing.eligibleForAggregation; }).forEach(function(listing){
      if(!groups[listing.familyKey]){
        groups[listing.familyKey] = {
          key:listing.familyKey,
          family:listing.family,
          capacity:listing.capacity,
          simKey:listing.simKey,
          simLabel:listing.simLabel,
          brand:listing.brand,
          listings:[]
        };
      }
      groups[listing.familyKey].listings.push(listing);
    });
    return Object.keys(groups).map(function(key){
      var group = groups[key];
      group.variants = unique(group.listings.map(function(item){ return item.variantKey; })).map(function(variantKey){
        var rows = group.listings.filter(function(item){ return item.variantKey === variantKey; });
        return {
          key:variantKey,
          quality:rows[0].quality,
          batteryKey:rows[0].batteryKey,
          batteryLabel:rows[0].batteryLabel,
          label:rows[0].quality + " · " + rows[0].batteryLabel,
          listings:rows,
          colors:unique(rows.map(function(item){ return item.color; }).filter(Boolean))
        };
      }).sort(function(a,b){ return a.label.localeCompare(b.label,"it"); });
      group.label = [group.family,group.capacity,group.simLabel].filter(Boolean).join(" · ");
      return group;
    }).sort(function(a,b){ return a.label.localeCompare(b.label,"it",{numeric:true}); });
  }

  function moneyAmount(competitor,field){
    var value = competitor && competitor[field];
    if(value && value.amount !== undefined) return core.toNumber(value.amount);
    return value === undefined || value === null ? null : core.toNumber(value);
  }

  function moneyCurrency(competitor,field,fallback){
    var value = competitor && competitor[field];
    return String(value && value.currency ? value.currency : fallback || "EUR").toUpperCase();
  }

  function attainablePrice(competitor,listing,settings){
    var field = finitePositive(moneyAmount(competitor,"price_to_win")) ? "price_to_win" : "winner_price";
    var amount = moneyAmount(competitor,field);
    if(!finitePositive(amount)) return null;
    var euro = core.amountToEuro(amount,moneyCurrency(competitor,field,listing.currency),settings);
    return finitePositive(euro) ? {euro:euro,source:field} : null;
  }

  function buildVariantBenchmarks(listings,payloadById,settings){
    var buckets = {};
    (listings || []).forEach(function(listing){
      if(!listing || !listing.eligibleForAggregation) return;
      var payload = payloadById && payloadById[listing.id];
      var competitors = payload && Array.isArray(payload.competitors) ? payload.competitors : [];
      competitors.forEach(function(competitor){
        var market = String(competitor && competitor.market || "").toUpperCase();
        if(!core.marketRule(market)) return;
        var price = attainablePrice(competitor,listing,settings);
        if(!price) return;
        buckets[listing.variantKey] = buckets[listing.variantKey] || {};
        buckets[listing.variantKey][market] = buckets[listing.variantKey][market] || [];
        buckets[listing.variantKey][market].push({value:price.euro,listingId:listing.id,color:listing.color,source:price.source});
      });
    });
    var output = {};
    Object.keys(buckets).forEach(function(variantKey){
      output[variantKey] = {markets:{}};
      Object.keys(buckets[variantKey]).forEach(function(market){
        var observations = buckets[variantKey][market];
        output[variantKey].markets[market] = {
          value:median(observations.map(function(item){ return item.value; })),
          colors:unique(observations.map(function(item){ return item.color; })).length,
          listings:unique(observations.map(function(item){ return item.listingId; })).length,
          priceToWin:observations.filter(function(item){ return item.source === "price_to_win"; }).length,
          total:observations.length
        };
      });
    });
    return output;
  }

  function weightedMarkets(benchmarks,weights){
    var requested = (weights || []).filter(function(item){ return item && core.toNumber(item.weight) > 0; });
    var totalWeight = requested.reduce(function(total,item){ return total + core.toNumber(item.weight); },0);
    var markets = {};
    Object.keys(core.MARKET_RULES).forEach(function(market){
      var available = requested.map(function(item){
        var entry = benchmarks[item.variantKey] && benchmarks[item.variantKey].markets[market];
        return entry && finitePositive(entry.value) ? {entry:entry,weight:core.toNumber(item.weight)} : null;
      }).filter(Boolean);
      var coveredWeight = available.reduce(function(total,item){ return total + item.weight; },0);
      if(!coveredWeight) return;
      markets[market] = {
        value:available.reduce(function(total,item){ return total + item.entry.value * item.weight; },0) / coveredWeight,
        coverage:totalWeight ? coveredWeight / totalWeight : 0,
        colors:available.reduce(function(total,item){ return total + item.entry.colors; },0),
        variants:available.length
      };
    });
    return {markets:markets,totalWeight:totalWeight};
  }

  function uncertainMarkets(benchmarks,variantKeys,scenario){
    var mode = ["conservative","central","favorable"].includes(scenario) ? scenario : "conservative";
    var markets = {};
    Object.keys(core.MARKET_RULES).forEach(function(market){
      var entries = (variantKeys || []).map(function(key){ return benchmarks[key] && benchmarks[key].markets[market]; }).filter(function(entry){ return entry && finitePositive(entry.value); });
      if(!entries.length) return;
      var values = entries.map(function(entry){ return entry.value; });
      var value = mode === "conservative" ? Math.min.apply(Math,values) : mode === "favorable" ? Math.max.apply(Math,values) : median(values);
      markets[market] = {
        value:value,
        coverage:entries.length / Math.max((variantKeys || []).length,1),
        colors:entries.reduce(function(total,item){ return total + item.colors; },0),
        variants:entries.length
      };
    });
    return {markets:markets,totalWeight:1};
  }

  function evaluateGroup(composed,marketCodes,purchasePrice,quantity,targetMargin,settings){
    var rows = (marketCodes || []).map(function(market){
      var benchmark = composed && composed.markets && composed.markets[market];
      if(!benchmark || !finitePositive(benchmark.value)) return null;
      var fee = core.marketFee(settings,market);
      if(fee === null) return null;
      var economics = core.calculateMargin(benchmark.value,purchasePrice,fee,settings,market);
      return {
        market:market,
        salePrice:benchmark.value,
        profit:economics.profit,
        margin:economics.margin,
        maximumPurchase:core.suggestedPurchaseForMargin(benchmark.value,fee,targetMargin,settings,market),
        coverage:benchmark.coverage,
        colors:benchmark.colors,
        variants:benchmark.variants
      };
    }).filter(Boolean);
    if(!rows.length) return null;
    var salePrice = mean(rows.map(function(row){ return row.salePrice; }));
    var profit = mean(rows.map(function(row){ return row.profit; }));
    return {
      salePrice:salePrice,
      profit:profit,
      totalProfit:profit * Math.max(core.toNumber(quantity),0),
      margin:salePrice ? profit / salePrice : 0,
      maximumPurchase:mean(rows.map(function(row){ return row.maximumPurchase; })),
      coverage:mean(rows.map(function(row){ return row.coverage; })),
      markets:rows.length,
      colors:Math.max.apply(Math,rows.map(function(row){ return row.colors; })),
      rows:rows
    };
  }

  return {
    GROUP_12:GROUP_12,
    GROUP_5:GROUP_5,
    mean:mean,
    median:median,
    groupFamilies:groupFamilies,
    buildVariantBenchmarks:buildVariantBenchmarks,
    weightedMarkets:weightedMarkets,
    uncertainMarkets:uncertainMarkets,
    evaluateGroup:evaluateGroup
  };
});
