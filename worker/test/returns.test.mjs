import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { parseReadyReturns } from "../src/ready-csv.js";
import { confirmReturnLoad, previewReturns, returnRoute } from "../src/returns.js";
import { saveMapping, purchaseRoute } from "../src/purchases.js";
import { processQuantityOrderItem, workQuantityOrder } from "../src/cancellations.js";
import { handleRequest } from "../src/index.js";

const header='"Data";"N.Doc.";"Cod.";"Descrizione";"Quant."\r\n';
const csv=header+
  '"07/09/2026";"3094";"13317";"Apple iPhone 14 128GB - Mezzanotte PREMIUM";"1"\r\n'+
  '"07/09/2026";"3107";"13317";"Apple iPhone 14 128GB - Mezzanotte PREMIUM";"1"\r\n';

class D1Test {
  constructor(){this.db=new DatabaseSync(":memory:");for(const name of ["0001_purchases.sql","0002_purchase_processing.sql","0005_client_cancellations.sql","0007_return_loads.sql"])this.db.exec(readFileSync(new URL("../migrations/"+name,import.meta.url),"utf8"));}
  prepare(sql){const database=this.db;const statement=(params=[])=>({bind:(...values)=>statement(values),async all(){return {results:database.prepare(sql).all(...params),success:true};},async first(){return database.prepare(sql).get(...params)||null;},async run(){const result=database.prepare(sql).run(...params);return {success:true,meta:{changes:result.changes}};}});return statement();}
  async batch(statements){this.db.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.run());this.db.exec("COMMIT");return results;}catch(error){this.db.exec("ROLLBACK");throw error;}}
}
function setup(t){const database=new D1Test();t.after(()=>database.db.close());return {database,env:{PURCHASES_DB:database,APP_ACCESS_KEY:"test-key",DRIVE_RETURNS_FILE_NAME:"resi.CSV"}};}
const listing=async id=>({id,sku:"SKU-"+id,quantity:5});
const mapping={ready_code:"13317",ready_description:"Apple iPhone 14",listing_id:"listing-13317",expected_revision:0,confirm:true};
const post=(path,payload)=>new Request("https://worker.test"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});

test("CSV resi raggruppa il codice ripetuto e conserva i riferimenti",()=>{
  const parsed=parseReadyReturns(csv);
  assert.equal(parsed.date,"2026-09-07");
  assert.equal(parsed.row_count,2);
  assert.equal(parsed.line_count,1);
  assert.equal(parsed.units,2);
  assert.deepEqual(parsed.lines[0].source_documents,["3094","3107"]);
});

test("CSV resi rifiuta prezzi, date miste e descrizioni conflittuali",()=>{
  assert.throws(()=>parseReadyReturns(csv.replace('"Quant."','"Quant.";"Pr.sc."')),{code:"INVALID_HEADER"});
  assert.throws(()=>parseReadyReturns(csv.replace('"07/09/2026";"3107"','"08/09/2026";"3107"')),{code:"MULTIPLE_RETURN_DATES"});
  assert.throws(()=>parseReadyReturns(csv.replace("Mezzanotte PREMIUM\";\"1\"\r\n","Mezzanotte ECCELLENTE\";\"1\"\r\n")),{code:"RETURN_PRODUCT_CONFLICT"});
});

test("anteprima condivide gli abbinamenti e il salvataggio non modifica quantità, costi o prezzi",async t=>{
  const {database,env}=setup(t);
  let preview=await previewReturns({source:"upload",name:"resi.CSV",csv},env);
  assert.equal(preview.batch.missing,1);
  assert.equal(preview.batch.token,null);
  assert.equal(database.db.prepare("SELECT count(*) n FROM quantity_orders").get().n,0);
  await saveMapping(mapping,env,listing);
  preview=await previewReturns({source:"upload",name:"resi.CSV",csv},env);
  assert.equal(preview.batch.missing,0);
  assert.equal(preview.batch.lines[0].mapping.sku,"SKU-listing-13317");
  const saved=await confirmReturnLoad({token:preview.batch.token,confirm:true},env);
  assert.equal(saved.load_number,"CR-2026-09-07-001");
  assert.equal(saved.backmarket_modified,false);
  assert.equal(saved.costs_modified,false);
  assert.equal(database.db.prepare("SELECT count(*) n FROM product_costs").get().n,0);
  assert.equal(database.db.prepare("SELECT quantity FROM quantity_order_lines").get().quantity,2);
  const retry=await confirmReturnLoad({token:preview.batch.token,confirm:true},env);
  assert.equal(retry.duplicate,true);
  assert.equal(database.db.prepare("SELECT count(*) n FROM return_loads").get().n,1);
});

test("progressivo giornaliero, archivio comune e lavorazione quantità sono idempotenti",async t=>{
  const {database,env}=setup(t);await saveMapping(mapping,env,listing);
  const first=await previewReturns({source:"upload",name:"resi.CSV",csv},env);const saved=await confirmReturnLoad({token:first.batch.token,confirm:true},env);
  const changed=csv.replaceAll('"1"\r\n','"2"\r\n');const second=await previewReturns({source:"upload",name:"resi.CSV",csv:changed},env);const saved2=await confirmReturnLoad({token:second.batch.token,confirm:true},env);
  assert.equal(saved2.load_number,"CR-2026-09-07-002");
  const work=await workQuantityOrder(saved.order_key,env);
  assert.equal(work.document.document_subtype,"ready_return");
  assert.deepEqual(work.items[0].source_references,["3094","3107"]);
  const url=new URL("https://worker.test/api/purchases/documents?status=pending");
  const archive=await purchaseRoute(new Request(url),url,env,{loadListing:listing,updateQuantity:async()=>{}});
  assert.equal(archive.results.filter(row=>row.document_subtype==="ready_return").length,2);
  let quantity=5,writes=0;const operations={loadListing:async id=>({id,sku:"SKU-"+id,quantity}),updateQuantity:async(_id,target)=>{writes++;quantity=target;}};
  const payload={document_key:saved.order_key,listing_id:"listing-13317",mode:"automatic",expected_bm_quantity:5,confirm:true};
  const result=await processQuantityOrderItem(payload,env,operations);const retry=await processQuantityOrderItem(payload,env,operations);
  assert.equal(result.target_quantity,7);assert.equal(quantity,7);assert.equal(writes,1);assert.equal(retry.duplicate,true);
  assert.equal(database.db.prepare("SELECT count(*) n FROM product_costs").get().n,0);
});

test("route resi espone stato e storico senza scritture Back Market",async t=>{
  const {env}=setup(t);
  const statusUrl=new URL("https://worker.test/api/returns/status");
  assert.equal((await returnRoute(new Request(statusUrl),statusUrl,env)).loads,0);
  const preview=await returnRoute(post("/api/returns/preview",{source:"upload",name:"resi.CSV",csv}),new URL("https://worker.test/api/returns/preview"),env);
  assert.equal(preview.backmarket_modified,false);
});

test("endpoint resi richiede il codice applicativo e non richiede credenziali Back Market",async t=>{
  const {env}=setup(t);const target="https://worker.test/api/returns/status";
  assert.equal((await handleRequest(new Request(target),env)).status,401);
  const response=await handleRequest(new Request(target,{headers:{"X-App-Key":env.APP_ACCESS_KEY}}),env);
  assert.equal(response.status,200);
  assert.equal((await response.json()).loads,0);
});
