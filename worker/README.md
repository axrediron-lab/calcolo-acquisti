# Calcolo Acquisti API

Proxy Cloudflare Worker protetto tra GitHub Pages e le API venditore Back Market.

## Segreti richiesti

I valori non devono essere salvati nel repository:

- `BACKMARKET_TOKEN`: token API creato nel back office venditore Back Market.
- `BACKMARKET_USER_AGENT`: stringa nel formato richiesto da Back Market, per esempio `BM-NomeAzienda-CalcoloAcquisti;email-contatto`.
- `APP_ACCESS_KEY`: codice lungo e casuale scelto per proteggere il catalogo esposto dalla Worker.

## Endpoint esposti

- `GET /health`: stato della configurazione, senza mostrare i valori dei segreti.
- `GET /api/catalog`: scarica tutte le inserzioni del merchant, seguendo la paginazione.
- `GET /api/backbox/:listingId`: legge le BuyBox di tutti i mercati per una singola inserzione.
- `GET /api/listings/:listingId?market=IT`: legge prezzo, minimo e quantità della singola inserzione nel mercato scelto.
- `POST /api/listings/:listingId`: aggiorna quantità globale oppure prezzo minimo e target di un mercato.

Gli endpoint `/api/*` richiedono l'header `X-App-Key`. Le scritture convalidano mercato, valuta, quantità e intervallo BackPricer prima di essere inoltrate a Back Market; il token venditore rimane sempre nei segreti Cloudflare.

## Configurazione manuale dei segreti

Dalla cartella `worker`, dopo avere effettuato personalmente l'accesso a Cloudflare:

```powershell
npx wrangler secret put BACKMARKET_TOKEN
npx wrangler secret put BACKMARKET_USER_AGENT
npx wrangler secret put APP_ACCESS_KEY
```

Ogni comando chiede il valore in modo interattivo, senza inserirlo nel file o nella cronologia del comando.

## Verifica locale

```powershell
node --test test/*.test.mjs
```

## Collegamento Drive: prima fase, sola lettura

La cartella e l'account tecnico sono configurati nelle variabili `DRIVE_FOLDER_ID`,
`DRIVE_SERVICE_ACCOUNT_EMAIL` e `DRIVE_FILE_NAME`. Non sono credenziali segrete.
Condividere esclusivamente la cartella dedicata con l'account tecnico come
Visualizzatore e mantenere l'accesso generale limitato.

Il valore `private_key` dell'account Google va inserito esclusivamente come
segreto Cloudflare `DRIVE_PRIVATE_KEY` (PEM, con righe reali o sequenze `\n`).
Non inserire l'intero JSON nel campo, non caricarlo in chat, nel sito o nel repository.
La chiave deve appartenere all'account indicato in `DRIVE_SERVICE_ACCOUNT_EMAIL`.
Non sono necessari ruoli amministrativi sul progetto né delega a livello di dominio.
Creare la chiave solo al momento della configurazione; revocarla se esposta e
prevederne la rotazione. Non registrare token, chiavi o contenuti CSV nei log.

Nuovi endpoint, entrambi protetti con il codice applicativo `X-App-Key`:

- `GET /api/drive/status`: verifica soltanto la presenza della configurazione,
  non certifica l'accesso a Google; non effettua chiamate esterne.
- `GET /api/drive/preview`: autentica l'account, cerca il nome esatto nella cartella,
  scarica il CSV e restituisce metadati, SHA-256 dei byte originali e testo CSV.
  `read_only: true` e `imported: false`: NON salva documenti o abbinamenti,
  NON aggiorna stock, costi o prezzi e NON chiama Back Market.

Il token Google usa solo `drive.readonly` e resta nella singola richiesta lato
server. Non vi è cache del CSV o delle credenziali. Download e risposte sono
limitati in dimensione e tempo; redirect rifiutati. Il CSV ha un limite applicativo
di 2 MiB, intestazione Ready a sei colonne e codifica UTF-8 o Windows-1252.
Le righe non sono ancora validate come documenti: questa non è un'importazione.
Un Foglio Google o un collegamento non sostituisce il CSV originale.

La lettura blocca file mancanti, nomi duplicati, ricerche incomplete e cambiamenti
rilevati durante il download (identità/versione/hash/dimensione). Riprovare dopo
la sincronizzazione se Drive sostituisce il file durante la verifica.

Prima del rilascio, eseguire i test; dopo configurazione del segreto e rilascio
autorizzato verificare prima lo stato e poi l'anteprima, senza stampare il CSV nei
log. La verifica Drive resta separata dall'importazione descritta sotto.

## Archivio Acquisti e Abbinamenti

Le pagine `acquisti.html` e `abbinamenti.html` usano il binding D1 `PURCHASES_DB`.
Applicare `migrations/0001_purchases.sql` con le migrazioni Wrangler prima del
rilascio. Usare `wrangler deploy --keep-vars` per preservare le variabili configurate
nel pannello. Non importare CSV operativi nel repository.

- `GET /api/purchases/status`: disponibilità e numero documenti.
- `POST /api/purchases/preview`: lettura Drive o CSV caricato, validazione e
  anteprima senza scritture. Gli abbinamenti mancanti bloccano la conferma.
- `POST /api/purchases/confirm`: salva un documento dopo conferma esplicita,
  usando l'anteprima firmata con scadenza di un'ora.
- `GET /api/purchases/documents` e `/api/purchases/document?key=...`: storico
  ricercabile e dettaglio con riferimenti d'origine e righe del file.
- `GET /api/mappings`, `GET /api/mappings/history?code=...` e
  `POST /api/mappings/save`: elenco, revisioni e modifica/rimozione futura.

Tutti richiedono `X-App-Key`. Il codice resta nella sessione della scheda, non
nel database; abbinamenti e documenti sono invece persistenti online.
La coppia anno/numero Ready impedisce duplicati; contenuti diversi per lo stesso
documento vengono bloccati senza sovrascrivere. Il salvataggio verifica che le
revisioni degli abbinamenti non siano cambiate dopo l'anteprima. Lo storico salva
lo SKU abbinato in quel momento: le modifiche successive non lo spostano.

Il semplice salvataggio del documento NON invia quantità o prezzi a Back Market
e mantiene lo stato storico `not_sent`. Costi e quantità vengono gestiti solo
dalla lavorazione separata descritta sotto.

## Lavorazione di costi e quantità

La migrazione `0002_purchase_processing.sql` aggiunge il costo medio online e
un registro idempotente per documento e inserzione. La pagina
`lavorazione.html?key=...` presenta esclusivamente gli articoli del documento.

- al primo acquisto il costo del documento diventa il costo iniziale, senza media;
- dagli acquisti successivi la media ponderata usa la quantità Back Market letta
  immediatamente prima della conferma;
- `prices_only` registra il costo e lascia la quantità in sospeso;
- `manual` registra che la quantità Back Market comprende già l'ordine e non invia
  alcuna scrittura;
- `automatic` verifica che la quantità non sia cambiata e invia la somma soltanto
  dopo conferma esplicita.

Una quantità in sospeso blocca la lavorazione di acquisti successivi per la stessa
inserzione, così la media non può usare una base ambigua. I retry dell'aggiornamento
automatico controllano la quantità corrente prima di ripetere la scrittura.
I prezzi restano sempre separati: il Monitor BuyBox legge `/api/purchases/costs`
e usa il costo online nei calcoli, ma ogni invio prezzo mantiene la propria
conferma esistente.

Verifiche dalla radice: `node --test tests/*.test.cjs worker/test/*.test.mjs`.
I test usano dati sintetici e SQLite in memoria, senza modifiche in produzione.

Attività successiva concordata: pulizia delle regole CSS obsolete dopo
l'implementazione delle nuove funzionalità, mantenendo il Mobile escluso.
