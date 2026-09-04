import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { handleRequest } from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  APP_ACCESS_KEY: "test-app-key",
  ALLOWED_ORIGINS: "https://site.test",
  DRIVE_FOLDER_ID: "folder-test",
  DRIVE_SERVICE_ACCOUNT_EMAIL: "test@project.iam.gserviceaccount.com",
  DRIVE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
};
const csv = '"Data";"N.Doc.";"Cod.";"Descrizione";"Quant.";"Pr.sc."\r\n"02/09/2026";"142";"123";"Prodotto";"2";"10,00"\r\n';
const file = {
  id: "file-test", name: "acquisti.CSV", mimeType: "text/csv",
  size: String(Buffer.byteLength(csv)), modifiedTime: "2026-09-04T10:00:00Z", version: "1",
  md5Checksum: createHash("md5").update(csv).digest("hex"),
};
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
const json = value => new Response(JSON.stringify(value));
function request(path = "preview", headers = {}, method = "GET") {
  return new Request(`https://worker.test/api/drive/${path}`, {
    method, headers: { Origin: "https://site.test", "X-App-Key": env.APP_ACCESS_KEY, ...headers },
  });
}
function mockGoogle({ listing = { files: [file] }, content = csv, after = listing, tokenResponse } = {}) {
  const calls = [];
  let lists = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    if (url.href === "https://oauth2.googleapis.com/token") {
      assert.equal(options.method, "POST");
      const assertion = new URLSearchParams(options.body).get("assertion");
      const [header, payload, signature] = assertion.split(".");
      assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      assert.equal(claims.scope, "https://www.googleapis.com/auth/drive.readonly");
      assert.equal(claims.iss, env.DRIVE_SERVICE_ACCOUNT_EMAIL);
      assert.equal(claims.aud, url.href);
      assert.equal(claims.exp - claims.iat, 300);
      assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
      return tokenResponse || json({ access_token: "google-test-token", token_type: "Bearer" });
    }
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer google-test-token");
    assert.equal(options.headers["X-App-Key"], undefined);
    if (url.searchParams.get("alt") === "media") return new Response(content);
    assert.equal(url.pathname, "/drive/v3/files");
    assert.match(url.searchParams.get("q"), /'folder-test' in parents/);
    assert.match(url.searchParams.get("q"), /name = 'acquisti.CSV'/);
    return json(lists++ ? after : listing);
  };
  return calls;
}

test("Drive: anteprima autenticata, firma verificata, nessuna scrittura e nessun token restituito", async () => {
  const calls = mockGoogle();
  const response = await handleRequest(request(), env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://site.test");
  assert.equal(payload.csv, csv);
  assert.equal(payload.read_only, true);
  assert.equal(payload.imported, false);
  assert.equal(payload.file.sha256, createHash("sha256").update(csv).digest("hex"));
  assert.doesNotMatch(JSON.stringify(payload), /google-test-token|PRIVATE KEY|test-app-key/);
  assert.equal(calls.length, 4);
});

test("Drive: stato locale senza richieste Google, indipendente da Back Market", async () => {
  globalThis.fetch = () => { throw new Error("Non deve usare la rete"); };
  const response = await handleRequest(request("status"), { APP_ACCESS_KEY: env.APP_ACCESS_KEY, ALLOWED_ORIGINS: env.ALLOWED_ORIGINS });
  assert.deepEqual(await response.json(), { folder: false, service_account: false, private_key: false, file_name: "acquisti.CSV", read_only: true });
});

for (const [label, req, config, status, code] of [
  ["senza accesso", request("preview", { "X-App-Key": "" }), env, 401, "ACCESS_REQUIRED"],
  ["origine vietata", request("preview", { Origin: "https://other.test" }), env, 403, "ORIGIN_DENIED"],
  ["scrittura vietata", request("preview", {}, "POST"), env, 405, "METHOD_NOT_ALLOWED"],
  ["segreto mancante", request(), { ...env, DRIVE_PRIVATE_KEY: "" }, 503, "DRIVE_NOT_CONFIGURED"],
  ["chiave malformata", request(), { ...env, DRIVE_PRIVATE_KEY: "secret-invalid-key" }, 503, "DRIVE_INVALID_KEY"],
  ["cartella non valida", request(), { ...env, DRIVE_FOLDER_ID: "bad'folder" }, 503, "DRIVE_INVALID_CONFIG"],
]) test(`Drive: ${label} senza accesso alla rete`, async () => {
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Non deve usare la rete"); };
  const response = await handleRequest(req, config);
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, code);
  assert.equal(calls, 0);
});

for (const [label, options, code] of [
  ["file assente", { listing: { files: [] } }, "DRIVE_FILE_NOT_FOUND"],
  ["nomi duplicati", { listing: { files: [file, { ...file, id: "other" }] } }, "DRIVE_DUPLICATE_NAME"],
  ["pagina aggiuntiva", { listing: { files: [file], nextPageToken: "next" } }, "DRIVE_DUPLICATE_NAME"],
  ["ricerca incompleta", { listing: { files: [file], incompleteSearch: true } }, "DRIVE_INVALID_RESPONSE"],
  ["Foglio Google", { listing: { files: [{ ...file, mimeType: "application/vnd.google-apps.spreadsheet" }] } }, "DRIVE_INVALID_FILE"],
  ["dimensione dichiarata eccessiva", { listing: { files: [{ ...file, size: "2097153" }] } }, "DRIVE_TOO_LARGE"],
  ["dimensione effettiva eccessiva", { content: "x".repeat(2097153) }, "DRIVE_TOO_LARGE"],
  ["file cambiato", { after: { files: [{ ...file, version: "2" }] } }, "DRIVE_FILE_CHANGED"],
  ["file sostituito", { after: { files: [{ ...file, id: "replacement" }] } }, "DRIVE_FILE_CHANGED"],
  ["contenuto incoerente", { content: csv.replace("Prodotto", "Cambiatо") }, "DRIVE_FILE_CHANGED"],
  ["token rifiutato", { tokenResponse: new Response("SECRET upstream details", { status: 403 }) }, "DRIVE_UPSTREAM_ERROR"],
  ["redirect rifiutato", { tokenResponse: new Response(null, { status: 302, headers: { Location: "https://other.invalid" } }) }, "DRIVE_UPSTREAM_ERROR"],
]) test(`Drive: ${label}`, async () => {
  mockGoogle(options);
  const response = await handleRequest(request(), env);
  assert.equal((await response.json()).code, code);
});

test("Drive: intestazione errata viene rifiutata anche con hash corretto", async () => {
  const content = "<html>Not CSV</html>";
  mockGoogle({ content, listing: { files: [{ ...file, size: String(content.length), md5Checksum: createHash("md5").update(content).digest("hex") }] } });
  const response = await handleRequest(request(), env);
  assert.equal((await response.json()).code, "DRIVE_INVALID_CSV");
});

test("Drive: errore di rete non espone dettagli sensibili", async () => {
  globalThis.fetch = async () => { throw new Error("SECRET credential details"); };
  const response = await handleRequest(request(), env);
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.match(text, /DRIVE_UNAVAILABLE/);
  assert.doesNotMatch(text, /SECRET|credential details/);
});
