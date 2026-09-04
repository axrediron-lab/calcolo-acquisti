import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const MAX_BYTES = 2 * 1024 * 1024;

export class DriveError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.details = {};
  }
}

export function driveStatus(env) {
  return {
    folder: Boolean(env.DRIVE_FOLDER_ID),
    service_account: Boolean(env.DRIVE_SERVICE_ACCOUNT_EMAIL),
    private_key: Boolean(env.DRIVE_PRIVATE_KEY),
    file_name: env.DRIVE_FILE_NAME || "acquisti.CSV",
    read_only: true,
  };
}

function fail(code, message, status = 502) {
  throw new DriveError(status, code, message);
}

// Bound streamed bodies as well as declared lengths; never log upstream bodies.
async function googleRead(url, options, limit = 64 * 1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Workerd supports manual/follow, not error. Reject every non-2xx below,
    // including redirects, without forwarding credentials to another address.
    const response = await fetch(url, { ...options, redirect: "manual", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      fail("DRIVE_UPSTREAM_ERROR", "Google non ha consentito la lettura. Verifica credenziali, condivisione e disponibilità del servizio.");
    }
    if (Number(response.headers.get("Content-Length")) > limit) {
      await response.body?.cancel();
      fail("DRIVE_TOO_LARGE", "File o risposta Google troppo grande", 413);
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel();
            fail("DRIVE_TOO_LARGE", "File o risposta Google troppo grande", 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof DriveError) throw error;
    fail("DRIVE_UNAVAILABLE", "Lettura Google non riuscita o scaduta. Riprova.");
  } finally {
    clearTimeout(timer);
  }
}

async function googleJson(url, options) {
  const bytes = await googleRead(url, options);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fail("DRIVE_INVALID_RESPONSE", "Risposta Google non valida");
  }
}

async function accessToken(env) {
  const status = driveStatus(env);
  if (!status.folder || !status.service_account || !status.private_key) {
    fail("DRIVE_NOT_CONFIGURED", "Collegamento Drive non ancora configurato", 503);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(env.DRIVE_FOLDER_ID) ||
      !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(env.DRIVE_SERVICE_ACCOUNT_EMAIL)) {
    fail("DRIVE_INVALID_CONFIG", "Configurazione Drive non valida", 503);
  }
  let assertion;
  try {
    const pem = String(env.DRIVE_PRIVATE_KEY).replace(/\\n/g, "\n");
    const body = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(body), c => c.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
      iss: env.DRIVE_SERVICE_ACCOUNT_EMAIL,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: TOKEN_URL, iat: now, exp: now + 300,
    });
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    assertion = unsigned + "." + Buffer.from(signature).toString("base64url");
  } catch {
    fail("DRIVE_INVALID_KEY", "Chiave privata Drive non valida", 503);
  }
  const token = await googleJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (typeof token.access_token !== "string" || !token.access_token || token.token_type?.toLowerCase() !== "bearer") {
    fail("DRIVE_INVALID_RESPONSE", "Autenticazione Google non valida");
  }
  return token.access_token;
}

export async function drivePreview(env) {
  const token = await accessToken(env);
  const options = { method: "GET", headers: { Authorization: `Bearer ${token}` } };
  const name = env.DRIVE_FILE_NAME || "acquisti.CSV";
  const escapeQuery = value => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = new URL(FILES_URL);
  query.search = new URLSearchParams({
    q: `'${env.DRIVE_FOLDER_ID}' in parents and name = '${escapeQuery(name)}' and trashed = false`,
    fields: "files(id,name,mimeType,size,modifiedTime,version,md5Checksum),nextPageToken,incompleteSearch",
    pageSize: "2",
  }).toString();
  const listed = await googleJson(query, options);
  if (!Array.isArray(listed.files) || listed.incompleteSearch) fail("DRIVE_INVALID_RESPONSE", "Ricerca Drive incompleta");
  if (listed.files.length > 1 || listed.nextPageToken) fail("DRIVE_DUPLICATE_NAME", "Più file con lo stesso nome nella cartella. Lascia un solo CSV.", 409);
  if (!listed.files.length) fail("DRIVE_FILE_NOT_FOUND", "CSV non trovato nella cartella accessibile all’account tecnico", 404);
  const file = listed.files[0];
  if (!/^[A-Za-z0-9_-]+$/.test(file.id) || file.name !== name ||
      typeof file.mimeType !== "string" || file.mimeType.startsWith("application/vnd.google-apps.") ||
      !/^\d+$/.test(String(file.size)) || !file.version || !file.modifiedTime ||
      !/^[a-f0-9]{32}$/i.test(file.md5Checksum || "")) {
    fail("DRIVE_INVALID_FILE", "È richiesto un file CSV originale, non un Foglio Google o un collegamento");
  }
  if (Number(file.size) > MAX_BYTES) fail("DRIVE_TOO_LARGE", "Il CSV supera il limite di 2 MiB", 413);
  const bytes = await googleRead(`${FILES_URL}/${file.id}?alt=media`, options, MAX_BYTES);
  const after = await googleJson(query, options);
  const current = after.files?.[0];
  if (after.incompleteSearch || after.nextPageToken || after.files?.length !== 1 ||
      !current || ["id", "version", "modifiedTime", "md5Checksum", "size"].some(field => current[field] !== file[field]) ||
      bytes.length !== Number(file.size) || createHash("md5").update(bytes).digest("hex") !== file.md5Checksum.toLowerCase()) {
    fail("DRIVE_FILE_CHANGED", "File cambiato durante la lettura. Attendi la sincronizzazione e riprova.", 409);
  }
  let csv;
  try { csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { csv = new TextDecoder("windows-1252").decode(bytes); }
  csv = csv.replace(/^\uFEFF/, "");
  if (csv.split(/\r?\n/, 1)[0].trim() !== '"Data";"N.Doc.";"Cod.";"Descrizione";"Quant.";"Pr.sc."' || csv.includes("\0")) {
    fail("DRIVE_INVALID_CSV", "Intestazione CSV diversa dall’esportazione Ready prevista", 422);
  }
  return {
    read_only: true, imported: false,
    checked_at: new Date().toISOString(),
    file: { id: file.id, name, modified_at: file.modifiedTime, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") },
    csv,
  };
}
