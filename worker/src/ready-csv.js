import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export class PurchaseError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; this.publicMessage = message; }
}
export function reject(code, message, status = 422) { throw new PurchaseError(status, code, message); }
export const hash = value => createHash("sha256").update(value).digest("hex");

// RFC-style quoted fields with semicolon separator, embedded newlines and source row numbers.
export function csvRows(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 2 * 1024 * 1024 || input.includes("\0")) reject("INVALID_CSV", "CSV non valido o superiore a 2 MiB");
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let cells = [], field = "", quoted = false, closed = false, line = 1, start = 1;
  const cell = () => { cells.push(field); field = ""; closed = false; };
  const row = () => { cell(); if (cells.some(c => c !== "")) rows.push({ row: start, cells }); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else { field += c; if (c === "\n") line++; }
    } else if (c === ";") cell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row(); line++; start = line;
    } else if (c === '"' && field === "" && !closed) quoted = true;
    else {
      if (closed || c === '"') reject("INVALID_CSV", `Virgolette non valide alla riga ${line}`);
      field += c;
    }
  }
  if (quoted) reject("INVALID_CSV", `Virgolette non chiuse alla riga ${start}`);
  if (field || cells.length || closed) row();
  if (rows.length > 5001) reject("CSV_LIMIT", "Il file supera 5.000 righe. Dividi l’esportazione.");
  return rows;
}
function date(value, row) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) reject("INVALID_DATE", `Data non valida alla riga ${row}`);
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const parsed = new Date(iso);
  if (Number(m[3]) < 2000 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) reject("INVALID_DATE", `Data non valida alla riga ${row}`);
  return iso;
}
function identifier(value, row) {
  if (!value || value.length > 100 || /[\x00-\x1f]/.test(value)) reject("INVALID_CODE", `Codice o numero documento non valido alla riga ${row}`);
  return value;
}
export function parseReady(csv) {
  const rows = csvRows(csv);
  if (JSON.stringify(rows.shift()?.cells) !== JSON.stringify(["Data", "N.Doc.", "Cod.", "Descrizione", "Quant.", "Pr.sc."])) reject("INVALID_HEADER", "Intestazione Ready attesa: Data; N.Doc.; Cod.; Descrizione; Quant.; Pr.sc.");
  const docs = new Map();
  for (const { row, cells } of rows) {
    if (cells.length !== 6) reject("INVALID_COLUMNS", `Servono sei colonne alla riga ${row}`);
    const [rawDate, numberRaw, code, description, quantity, price] = cells.map(c => c.trim());
    const documentDate = date(rawDate, row);
    const number = identifier(numberRaw, row);
    const year = Number(documentDate.slice(0, 4));
    const key = `${year}:${number}`;
    if (!docs.has(key)) docs.set(key, { key, number, year, date: documentDate, references: [], lines: [], units: 0, total_cents: 0 });
    const doc = docs.get(key);
    if (doc.date !== documentDate) reject("DOCUMENT_CONFLICT", `Documento ${number}: date diverse nello stesso anno`);
    if (description.length > 2000) reject("INVALID_DESCRIPTION", `Descrizione troppo lunga alla riga ${row}`);
    if (!code) {
      const match = /^Rif\.\s*Ord\.f\.\s*N\.\s*(.+?)\s+del\s+(\d{2}\/\d{2}\/\d{4})$/i.exec(description);
      if (!match || quantity || price) reject("UNKNOWN_REFERENCE", `Riga ${row} senza codice prodotto non riconosciuta: verifica il riferimento`);
      doc.references.push({ number: identifier(match[1], row), date: date(match[2], row), text: description, source_row: row });
      continue;
    }
    identifier(code, row);
    if (!description || !/^\d+$/.test(quantity) || Number(quantity) < 1 || !Number.isSafeInteger(Number(quantity))) reject("INVALID_QUANTITY", `Descrizione o quantità non valida alla riga ${row}`);
    if (!/^\d+(?:,\d{1,2})?$/.test(price)) reject("INVALID_COST", `Costo unitario EUR non valido alla riga ${row}`);
    const [whole, decimals = ""] = price.split(",");
    const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
    const qty = Number(quantity);
    if (!Number.isSafeInteger(cents) || cents <= 0 || !Number.isSafeInteger(cents * qty)) reject("INVALID_COST", `Costo non valido alla riga ${row}`);
    doc.lines.push({ ready_code: code, description, quantity: qty, unit_cost_cents: cents, source_row: row, reference: doc.references.at(-1) || null });
    doc.units += qty; doc.total_cents += cents * qty;
    if (!Number.isSafeInteger(doc.units) || !Number.isSafeInteger(doc.total_cents)) reject("CSV_LIMIT", "Totali troppo grandi");
  }
  if (!docs.size || docs.size > 100) reject("CSV_LIMIT", "Il file deve contenere da 1 a 100 documenti");
  for (const doc of docs.values()) {
    if (!doc.lines.length || doc.lines.length > 1000) reject("CSV_LIMIT", `Documento ${doc.number}: servono da 1 a 1.000 righe prodotto`);
    // Ignore physical line order/formatting for deduplication, preserve repeated product lines.
    const ref = r => r ? [r.number, r.date, r.text] : null;
    doc.hash = hash(JSON.stringify([doc.key, doc.date,
      doc.references.map(ref).map(JSON.stringify).sort(),
      doc.lines.map(l => JSON.stringify([l.ready_code, l.description, l.quantity, l.unit_cost_cents, ref(l.reference)])).sort()]));
  }
  return [...docs.values()];
}

export function parseReadyReturns(csv) {
  const rows = csvRows(csv);
  if (JSON.stringify(rows.shift()?.cells) !== JSON.stringify(["Data", "N.Doc.", "Cod.", "Descrizione", "Quant."])) {
    reject("INVALID_HEADER", "Intestazione resi attesa: Data; N.Doc.; Cod.; Descrizione; Quant.");
  }
  if (!rows.length) reject("CSV_LIMIT", "Il file resi non contiene prodotti");

  let loadDate = null;
  let units = 0;
  const grouped = new Map();
  const sourceDocuments = new Set();
  const fingerprintRows = [];
  for (const { row, cells } of rows) {
    if (cells.length !== 5) reject("INVALID_COLUMNS", `Servono cinque colonne alla riga ${row}`);
    const [rawDate, documentRaw, codeRaw, descriptionRaw, quantityRaw] = cells.map(cell => cell.trim());
    const currentDate = date(rawDate, row);
    if (loadDate && currentDate !== loadDate) reject("MULTIPLE_RETURN_DATES", "Il file resi deve contenere una sola data di carico");
    loadDate = currentDate;
    const sourceDocument = identifier(documentRaw, row);
    const code = identifier(codeRaw, row);
    const description = descriptionRaw;
    if (!description || description.length > 2000) reject("INVALID_DESCRIPTION", `Descrizione non valida alla riga ${row}`);
    if (!/^\d+$/.test(quantityRaw) || Number(quantityRaw) < 1 || !Number.isSafeInteger(Number(quantityRaw))) {
      reject("INVALID_QUANTITY", `Quantità non valida alla riga ${row}`);
    }
    const quantity = Number(quantityRaw);
    const current = grouped.get(code) || { ready_code: code, description, quantity: 0, source_rows: [], source_documents: [] };
    if (current.description !== description) reject("RETURN_PRODUCT_CONFLICT", `Codice ${code}: descrizioni diverse nello stesso file`);
    current.quantity += quantity;
    units += quantity;
    if (!Number.isSafeInteger(current.quantity) || !Number.isSafeInteger(units)) reject("CSV_LIMIT", "Totali troppo grandi");
    current.source_rows.push(row);
    if (!current.source_documents.includes(sourceDocument)) current.source_documents.push(sourceDocument);
    sourceDocuments.add(sourceDocument);
    grouped.set(code, current);
    fingerprintRows.push(JSON.stringify([currentDate, sourceDocument, code, description, quantity]));
  }
  if (grouped.size > 1000) reject("CSV_LIMIT", "Il file resi supera 1.000 articoli distinti");
  const lines = [...grouped.values()].sort((a, b) => a.ready_code.localeCompare(b.ready_code, "it"));
  return {
    date: loadDate,
    row_count: rows.length,
    line_count: lines.length,
    units,
    source_documents: [...sourceDocuments].sort((a, b) => a.localeCompare(b, "it", { numeric: true })),
    lines,
    hash: hash(JSON.stringify([loadDate, fingerprintRows.sort()])),
  };
}
