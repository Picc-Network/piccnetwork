# PICC Network Relayer

Meta-transaction relayer per PICC Network su Polygon Mainnet.

## Variabili d'ambiente necessarie su Vercel

Vai su Vercel → Settings → Environment Variables e aggiungi:

| Nome | Valore |
|---|---|
| `POLYGON_RPC_URL` | `https://polygon-mainnet.g.alchemy.com/v2/mxVpnyM_xC_NbAAMy8iEQ` |
| `RELAYER_PRIVATE_KEY` | La chiave privata del wallet deployer |

## Endpoints

- `GET /api/health` — stato del relayer
- `GET /api/nonce?address=0x...` — nonce corrente dell'utente
- `POST /api/relay` — esegue una meta-transazione

## Contratti v3 (Polygon Mainnet)

- PICCForwarder: `0xF6757B82D8ab0cAA74d5C886e93F9EAbDcdC6567`
- PICCToken:     `0x7168696C997A2CE2Fd05224D79B69C09255085d1`
- PICCVoucher:   `0x430483F0cd869D3Ff2446ce57333d6AFC5592351`
