(function () {
  "use strict";
  var endpoint = "https://calcolo-acquisti-api.axrediron-lab.workers.dev/api/drive/preview";
  var form = document.getElementById("driveCheckForm");
  var keyInput = document.getElementById("driveAccessKey");
  var rotated = document.getElementById("keyRotated");
  var button = document.getElementById("driveCheckButton");
  var status = document.getElementById("driveCheckStatus");
  var result = document.getElementById("driveCheckResult");
  var busy = false;
  var messages = {
    ACCESS_REQUIRED: "Codice non valido. Usa il nuovo APP_ACCESS_KEY salvato su Cloudflare.",
    NOT_CONFIGURED: "Il codice applicativo non è configurato sul server.",
    DRIVE_NOT_CONFIGURED: "Configurazione Drive incompleta: controlla il segreto e le variabili del server.",
    DRIVE_INVALID_CONFIG: "Le variabili del collegamento Drive non sono valide.",
    DRIVE_INVALID_KEY: "La chiave Google nel segreto DRIVE_PRIVATE_KEY non è valida.",
    DRIVE_UPSTREAM_ERROR: "Google non ha consentito la lettura. Controlla chiave, condivisione della cartella e disponibilità del servizio.",
    DRIVE_FILE_NOT_FOUND: "acquisti.CSV non è stato trovato. Controlla nome, cartella e sincronizzazione.",
    DRIVE_DUPLICATE_NAME: "Ci sono più file acquisti.CSV nella cartella. Lascia un solo file e riprova.",
    DRIVE_FILE_CHANGED: "Il file è cambiato durante la lettura. Attendi la sincronizzazione e riprova.",
    DRIVE_TOO_LARGE: "Il file o la risposta supera il limite consentito. Il CSV può contenere al massimo 2 MiB.",
    DRIVE_INVALID_FILE: "Carica il CSV originale, non un Foglio Google o un collegamento.",
    DRIVE_INVALID_CSV: "L’intestazione non corrisponde al CSV Ready previsto.",
    DRIVE_UNAVAILABLE: "Google non è raggiungibile oppure la lettura è scaduta. Riprova.",
    ORIGIN_DENIED: "Questa pagina non è autorizzata dal server.",
  };
  function enableButton() { button.disabled = busy || !rotated.checked; }
  rotated.addEventListener("change", enableButton);
  window.addEventListener("pagehide", function () { keyInput.value = ""; });
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (busy || !rotated.checked || !form.reportValidity()) return;
    var key = keyInput.value.trim();
    keyInput.value = "";
    result.hidden = true;
    if (!key) { status.textContent = "Inserisci il nuovo codice di accesso."; return; }
    busy = true;
    enableButton();
    keyInput.disabled = true;
    status.textContent = "Lettura di acquisti.CSV in corso…";
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 70000);
    try {
      var pending = fetch(endpoint, {
        method: "GET", headers: { "X-App-Key": key },
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      key = "";
      var response = await pending;
      var payload = await response.json();
      if (!response.ok) {
        status.textContent = messages[payload.code] || "Verifica non riuscita. Riprova o controlla la configurazione del server.";
        return;
      }
      if (payload.read_only !== true || payload.imported !== false || !payload.file ||
          typeof payload.file.name !== "string" || !Number.isFinite(payload.file.size) ||
          !Number.isFinite(Date.parse(payload.file.modified_at))) throw new Error("Invalid response");
      document.getElementById("driveFileName").textContent = payload.file.name;
      document.getElementById("driveFileSize").textContent = payload.file.size.toLocaleString("it-IT") + " byte";
      document.getElementById("driveFileModified").textContent = new Date(payload.file.modified_at).toLocaleString("it-IT");
      // The preview body is neither rendered nor persisted; only metadata is shown.
      payload.csv = null;
      status.textContent = "Collegamento Drive funzionante. Nessun dato modificato.";
      result.hidden = false;
    } catch (error) {
      status.textContent = error.name === "AbortError"
        ? "La verifica ha impiegato troppo tempo. Riprova tra poco."
        : "Impossibile completare la verifica. Controlla la connessione e riprova.";
    } finally {
      key = "";
      clearTimeout(timer);
      busy = false;
      keyInput.disabled = false;
      enableButton();
    }
  });
  enableButton();
}());
