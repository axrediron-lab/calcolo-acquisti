import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { parseReady } from "../src/ready-csv.js";
import { previewPurchases, confirmPurchase, saveMapping, purchaseRoute } from "../src/purchases.js";
import { handleRequest } from "../src/index.js";

const header = '"Data";"N.Doc.";"Cod.";"Descrizione";"Quant.";"Pr.sc."\r\n';
const reference = '"02/09/2026";"142";"";"Rif. Ord.f. N. 136 del 02/09/2026";"";""\r\n';
const product = '"02/09/2026";"142";"00123";"Prodotto test";"2";"10,25"\r\n';
const csv = header + reference + product;
class D1Test {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../migrations/0001_purchases.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const database = this.db;
    const statement = (params = []) => ({
      bind: (...p) => statement(p),
      async all() { return { results: database.prepare(sql).all(...params), success: true }; },
      async first() { return database.prepare(sql).get(...params) || null; },
      async run() { const r = database.prepare(sql).run(...params); return { success:true, meta: {changes:r.changes} }; },
    });
    return statement();
  }
  async batch(statements) { this.db.exec('BEGIN'); try { const result = []; for (const s of statements) result.push(await s.run()); this.db.exec('COMMIT'); return result; } catch(e) {this.db.exec('ROLLBACK'); throw e;} }
}
function setup(t) {
  const database = new D1Test(); t.after(() => database.db.close());
  const env = { PURCHASES_DB:database, APP_ACCESS_KEY:'test-secret-not-real', ALLOWED_ORIGINS:'https://test.local' };
  return {env, database};
}
const listing = async id => ({id,sku:'SKU-' + id});
const mapping = (revision = 0, listingId = 'listing-123') => ({ready_code:'00123',ready_description:'Prodotto test',listing_id:listingId,expected_revision:revision,confirm:true});
async function preview(env, input = csv) { return (await previewPurchases({source:'upload',name:'test.csv',csv:input},env)).documents[0]; }

test('CSV Ready: riferimenti separati, centesimi esatti, codici con zeri preservati', () => {
  const d = parseReady(csv)[0];
  assert.equal(d.key,'2026:142'); assert.equal(d.units,2); assert.equal(d.total_cents,2050);
  assert.equal(d.lines[0].ready_code,'00123'); assert.equal(d.lines[0].source_row,3);
  assert.equal(d.references[0].number,'136'); assert.equal(d.references[0].date,'2026-09-02');
});
test('CSV: BOM, delimitatori e newline dentro descrizioni quotate', () => {
  const d = parseReady('\ufeff' + csv.replace('Prodotto test','Prodotto; ""test""\nseconda riga'))[0];
  assert.equal(d.lines[0].description,'Prodotto; "test"\nseconda riga');
});
test('CSV: stesso documento in anni diversi non collide', () => {
  assert.equal(parseReady(csv + product.replaceAll('2026','2027')).length,2);
});
test('CSV: impronta non dipende da newline o ordine delle righe prodotto', () => {
  const a = csv + product.replace('00123','00456');
  const b = header + reference + product.replace('00123','00456') + product;
  assert.equal(parseReady(a)[0].hash,parseReady(b.replaceAll('\r\n','\n'))[0].hash);
});
for (const [label,input] of [
  ['data impossibile',csv.replaceAll('02/09/2026','31/02/2026')],
  ['mese impossibile',csv.replaceAll('02/09/2026','02/99/2026')],
  ['quantità zero',csv.replace(';"2";', ';"0";')],
  ['quantità negativa',csv.replace(';"2";', ';"-1";')],
  ['costo assente',csv.replace('"10,25"','""')],
  ['riferimento ignoto',csv.replace('Rif. Ord.f.','Nota')],
  ['date documento discordi',csv + product.replaceAll('02/09/2026','03/09/2026')],
  ['virgolette aperte',csv + '"unfinished'],
  ['nessun prodotto',header + reference],
]) test('CSV rifiuta ' + label, () => assert.throws(() => parseReady(input)));

test('anteprima non scrive documenti e chiede mapping mancante', async t => {
  const {env,database} = setup(t); const d = await preview(env);
  assert.equal(d.missing,1); assert.equal(d.token,null);
  assert.equal(database.db.prepare('SELECT count(*) n FROM purchase_documents').get().n,0);
});
test('salvataggio online idempotente e nessuna quantità inviata', async t => {
  const {env,database} = setup(t); await saveMapping(mapping(),env,listing);
  const d = await preview(env); assert.equal(d.missing,0);
  const first = await confirmPurchase({token:d.token,confirm:true},env);
  const retry = await confirmPurchase({token:d.token,confirm:true},env);
  assert.equal(first.duplicate,false); assert.equal(retry.duplicate,true);
  assert.equal(first.stock_status,'not_sent');
  assert.equal(database.db.prepare('SELECT count(*) n FROM purchase_documents').get().n,1);
  assert.equal((await preview(env)).status,'duplicate');
});
test('documento corretto non sovrascrive acquisto già salvato', async t => {
  const {env} = setup(t); await saveMapping(mapping(),env,listing);
  const original = await preview(env); const changed = await preview(env,csv.replace('10,25','12,00'));
  await confirmPurchase({token:original.token,confirm:true},env);
  await assert.rejects(() => confirmPurchase({token:changed.token,confirm:true},env), {code:'DOCUMENT_CONFLICT'});
  assert.equal((await preview(env,csv.replace('10,25','12,00'))).status,'conflict');
});
test('sostituzione futura e rimozione non cambiano snapshot storici', async t => {
  const {env,database} = setup(t); await saveMapping(mapping(),env,listing);
  const d = await preview(env); await confirmPurchase({token:d.token,confirm:true},env);
  await saveMapping(mapping(1,'listing-999'),env,listing);
  const historical = JSON.parse(database.db.prepare('SELECT lines_json FROM purchase_documents').get().lines_json);
  assert.equal(historical[0].mapping.sku,'SKU-listing-123');
  assert.equal((await preview(env,csv.replaceAll('"142"','"143"'))).lines[0].mapping.sku,'SKU-listing-999');
  await saveMapping({...mapping(2),remove:true},env,listing);
  assert.equal((await preview(env,csv.replaceAll('"142"','"143"'))).missing,1);
  assert.equal(database.db.prepare('SELECT count(*) n FROM mapping_history').get().n,3);
});
test('modifica mapping dopo anteprima blocca la conferma del nuovo documento', async t => {
  const {env} = setup(t); await saveMapping(mapping(),env,listing); const d = await preview(env);
  await saveMapping(mapping(1,'listing-999'),env,listing);
  await assert.rejects(() => confirmPurchase({token:d.token,confirm:true},env), {code:'MAPPING_CHANGED'});
});
test('modifica concorrente e SKU già assegnato sono respinti', async t => {
  const {env,database} = setup(t); await saveMapping(mapping(),env,listing);
  await assert.rejects(() => saveMapping(mapping(0,'listing-999'),env,listing), {code:'MAPPING_CHANGED'});
  await assert.rejects(() => saveMapping({...mapping(),ready_code:'different'},env,listing), {code:'SKU_ALREADY_MAPPED'});
  assert.equal(database.db.prepare('SELECT count(*) n FROM mapping_history').get().n,1);
});
test('token manomesso e conferma omessa non scrivono dati', async t => {
  const {env} = setup(t); await saveMapping(mapping(),env,listing); const d = await preview(env);
  await assert.rejects(() => confirmPurchase({token:d.token + 'bad',confirm:true},env), {code:'INVALID_PREVIEW'});
  await assert.rejects(() => confirmPurchase({token:d.token},env), {code:'CONFIRM_REQUIRED'});
});
test('storico consultabile per numero riferimento e dettaglio immutabile', async t => {
  const {env} = setup(t); await saveMapping(mapping(),env,listing); const d = await preview(env);
  await confirmPurchase({token:d.token,confirm:true},env);
  const url = new URL('https://test.local/api/purchases/documents?q=136');
  const result = await purchaseRoute(new Request(url),url,env,listing);
  assert.equal(result.results[0].document_number,'142');
  const detail = new URL('https://test.local/api/purchases/document?key=2026:142');
  assert.equal((await purchaseRoute(new Request(detail),detail,env,listing)).lines[0].unit_cost_cents,1025);
});
test('API acquisti e abbinamenti protette, nessuna necessità di segreti Back Market per storico', async t => {
  const {env} = setup(t);
  for (const path of ['/api/purchases/status','/api/mappings']) {
    assert.equal((await handleRequest(new Request('https://test.local'+path),env)).status,401);
    assert.equal((await handleRequest(new Request('https://test.local'+path,{headers:{'X-App-Key':env.APP_ACCESS_KEY}}),env)).status,200);
  }
});
