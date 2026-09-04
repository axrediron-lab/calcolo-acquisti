const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'verifica-drive.js'), 'utf8');
function page(fetch) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {value:'',checked:false,hidden:true,events:{},textContent:'',
      addEventListener(event, fn) { this.events[event] = fn; }, reportValidity() { return true; }});
    return elements.get(id);
  };
  vm.runInNewContext(source, {document:{getElementById:get}, window:{addEventListener(){}},fetch,AbortController,setTimeout,clearTimeout});
  return { get, submit: () => get('driveCheckForm').events.submit({preventDefault(){}}) };
}
test('verifica Drive usa password, CSS unico e impedisce invii HTML senza JavaScript', () => {
  const html = fs.readFileSync(path.join(root, 'verifica-drive.html'), 'utf8');
  assert.match(html, /type="password"/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /href="styles\.css\?v=drive-check-1"/);
  assert.doesNotMatch(html, /<style|style=/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|innerHTML/);
});
test('verifica Drive non invia nulla prima della conferma rotazione', async () => {
  let calls = 0;
  const p = page(async () => { calls++; });
  await p.submit();
  assert.equal(calls, 0);
  assert.equal(p.get('driveCheckButton').disabled, true);
});
test('verifica Drive: solo GET al Worker, codice svuotato e nessun CSV visualizzato', async () => {
  const p = page(async (url, options) => {
    assert.equal(url, 'https://calcolo-acquisti-api.axrediron-lab.workers.dev/api/drive/preview');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['X-App-Key'], 'test-key');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(p.get('driveAccessKey').value, '');
    return {ok:true,json:async()=>({read_only:true,imported:false,file:{name:'acquisti.CSV',size:3005,modified_at:'2026-09-04T10:00:00Z'},csv:'private data'})};
  });
  p.get('keyRotated').checked = true;
  p.get('driveAccessKey').value = 'test-key';
  await p.submit();
  assert.equal(p.get('driveCheckResult').hidden, false);
  assert.equal(p.get('driveFileName').textContent, 'acquisti.CSV');
  assert.equal(p.get('driveAccessKey').value, '');
});
test('verifica Drive mostra solo messaggi controllati e riabilita il modulo', async () => {
  const p = page(async () => ({ok:false,json:async()=>({code:'ACCESS_REQUIRED',error:'sensitive upstream detail'})}));
  p.get('keyRotated').checked = true;
  p.get('driveAccessKey').value = 'test-key';
  await p.submit();
  assert.match(p.get('driveCheckStatus').textContent, /Codice non valido/);
  assert.equal(p.get('driveCheckResult').hidden, true);
  assert.equal(p.get('driveCheckButton').disabled, false);
  assert.equal(p.get('driveAccessKey').value, '');
});
test('verifica Drive gestisce errore rete senza mostrare dettagli o credenziali', async () => {
  const p = page(async () => {throw new Error('sensitive detail');});
  p.get('keyRotated').checked = true;
  p.get('driveAccessKey').value = 'test-key';
  await p.submit();
  assert.match(p.get('driveCheckStatus').textContent, /Impossibile completare/);
  assert.equal(p.get('driveAccessKey').value, '');
});
