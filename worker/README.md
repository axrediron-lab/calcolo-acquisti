# Calcolo Acquisti API

Proxy Cloudflare Worker in sola lettura tra GitHub Pages e le API venditore Back Market.

## Segreti richiesti

I valori non devono essere salvati nel repository:

- `BACKMARKET_TOKEN`: token API creato nel back office venditore Back Market.
- `BACKMARKET_USER_AGENT`: stringa nel formato richiesto da Back Market, per esempio `BM-NomeAzienda-CalcoloAcquisti;email-contatto`.
- `APP_ACCESS_KEY`: codice lungo e casuale scelto per proteggere il catalogo esposto dalla Worker.

## Endpoint esposti

- `GET /health`: stato della configurazione, senza mostrare i valori dei segreti.
- `GET /api/catalog`: scarica tutte le inserzioni del merchant, seguendo la paginazione.
- `GET /api/backbox/:listingId?market=IT`: legge la BackBox per una singola inserzione.

Gli endpoint `/api/*` richiedono l'header `X-App-Key`. Non sono presenti chiamate di scrittura verso Back Market.

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
