const { ethers } = require("ethers");

const PICC_TOKEN_ADDRESS   = "0x2254a5067f212E1118c4D0C34D819a78f8528Ca5";
const PICC_VOUCHER_ADDRESS = "0x0647190223E1f83c885b37fAFd3f8aC9a74d5f8F";
const FORWARDER_ADDRESS    = "0xF6757B82D8ab0cAA74d5C886e93F9EAbDcdC6567";

const FORWARDER_ABI = [
  "function getNonce(address from) view returns (uint256)",
  "function verify((address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data) req, bytes signature) view returns (bool)",
  "function execute((address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data) req, bytes signature) payable returns (bool, bytes)"
];

// Usata solo per decodificare le chiamate "transfer" dirette sul token PICC,
// per sapere a chi notificare un pagamento in arrivo.
const TOKEN_IFACE = new ethers.utils.Interface([
  "function transfer(address to, uint256 value) returns (bool)"
]);

// Selettore della funzione riscattaBonusBenvenuto() (nessun parametro), per riconoscerla
// dentro il campo "data" senza dover decodificare l'intera chiamata.
const SELETTORE_RISCATTA_BONUS = ethers.utils.id("riscattaBonusBenvenuto()").slice(0, 10);

// Wallet di test: saltano il controllo anti-abuso sul bonus di benvenuto (usati per
// sviluppo/test, dove è normale reinstallare l'app più volte sullo stesso dispositivo).
// 🔴 Aggiungi qui ogni nuovo wallet di test che crei.
const WALLET_DI_TEST = [
  "0xe4913dd350e8F503247e337573b4019450E00d5B", // Sergio
  "0x36fb264545a005b8c147a97078b8879103cfec2c"  // moglie
].map(a => a.toLowerCase());

/**
 * Se la chiamata è un riscatto del bonus di benvenuto, verifica che questo stesso
 * dispositivo (identificato dall'Android ID mandato dall'app) non abbia già riscosso
 * il bonus su un ALTRO wallet — impedisce di disinstallare/reinstallare l'app creando
 * wallet nuovi per accumulare il bonus più volte. Ritorna null se tutto ok (via libera),
 * altrimenti il messaggio di errore da restituire.
 */
async function verificaAntiAbusoBonus(to, data, from, deviceId) {
  if (to.toLowerCase() !== PICC_TOKEN_ADDRESS.toLowerCase()) return null; // non è sul token
  if (!data.startsWith(SELETTORE_RISCATTA_BONUS)) return null; // non è riscattaBonusBenvenuto

  if (WALLET_DI_TEST.includes(from.toLowerCase())) return null; // wallet di test, nessun controllo

  if (!firestoreDb) {
    console.error("Firestore non disponibile: controllo anti-abuso bonus saltato per errore tecnico");
    return null; // non blocchiamo per un problema nostro, solo per abuso rilevato
  }

  if (!deviceId) {
    return "PICC: identificativo dispositivo mancante, impossibile verificare il bonus";
  }

  const doc = await firestoreDb.collection("device_bonus_claims").doc(deviceId).get();
  if (doc.exists && doc.data().wallet && doc.data().wallet.toLowerCase() !== from.toLowerCase()) {
    return "PICC: bonus di benvenuto gia' riscosso su questo dispositivo con un altro wallet";
  }
  return null;
}

/**
 * Registra su Firestore quale wallet ha riscattato il bonus su questo dispositivo,
 * da chiamare solo DOPO che la transazione è andata a buon fine.
 */
async function registraDispositivoBonus(to, data, from, deviceId) {
  try {
    if (!firestoreDb) return;
    if (to.toLowerCase() !== PICC_TOKEN_ADDRESS.toLowerCase()) return;
    if (!data.startsWith(SELETTORE_RISCATTA_BONUS)) return;
    if (!deviceId) return;
    await firestoreDb.collection("device_bonus_claims").doc(deviceId).set({
      wallet: from,
      timestamp: Date.now()
    });
  } catch (e) {
    console.error("Errore registrazione dispositivo bonus:", e.message);
  }
}

// --- Firebase Admin (API modulare v12+): caricamento e inizializzazione protetti da try/catch ---
// IMPORTANTE: questo blocco NON deve mai poter bloccare l'intera funzione.
// Se firebase-admin non si carica o la chiave di servizio non è valida,
// le notifiche push si disattivano da sole ma i pagamenti continuano a funzionare.
let firebaseApp = null;
let firestoreDb = null;
let messaging = null;
try {
  const { initializeApp, getApps, cert } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { getMessaging } = require("firebase-admin/messaging");

  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  } else {
    firebaseApp = getApps()[0];
  }
  firestoreDb = getFirestore(firebaseApp);
  messaging = getMessaging(firebaseApp);
} catch (e) {
  console.error("Firebase Admin non disponibile, notifiche push disattivate:", e.message);
  firebaseApp = null;
}

/**
 * Se la chiamata è un transfer diretto sul token PICC, cerca il token FCM del
 * destinatario su Firestore e gli invia una notifica push. Non blocca né fa fallire
 * la risposta del relayer in caso di errore: il pagamento resta valido comunque.
 */
async function notificaDestinatarioSePossibile(to, data, txHash) {
  try {
    if (!firebaseApp || !firestoreDb || !messaging) return; // Firebase Admin non disponibile
    if (to.toLowerCase() !== PICC_TOKEN_ADDRESS.toLowerCase()) return; // non è un transfer diretto

    const decoded = TOKEN_IFACE.parseTransaction({ data });
    if (decoded.name !== "transfer") return;

    const destinatario = decoded.args.to.toLowerCase();
    const importo = ethers.utils.formatUnits(decoded.args.value, 18);

    const doc = await firestoreDb.collection("fcm_tokens").doc(destinatario).get();
    if (!doc.exists) return; // destinatario senza token registrato (o mai aperto l'app)

    const token = doc.data().token;
    if (!token) return;

    await messaging.send({
      token,
      notification: {
        title: "PICC ricevuti",
        body: `Hai ricevuto ${parseFloat(importo).toFixed(2)} PICC`
      },
      data: {
        txHash: txHash || ""
      }
    });
    console.log(`Notifica push inviata a ${destinatario}`);
  } catch (e) {
    // Non facciamo mai fallire il pagamento per un errore di notifica
    console.error("Errore invio notifica push:", e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { from, to, data, signature, nonce, gas, deviceId } = req.body;
    if (!from || !to || !data || !signature) {
      return res.status(400).json({ error: "Parametri mancanti: from, to, data, signature" });
    }
    const allowedContracts = [
      PICC_TOKEN_ADDRESS.toLowerCase(),
      PICC_VOUCHER_ADDRESS.toLowerCase()
    ];
    if (!allowedContracts.includes(to.toLowerCase())) {
      return res.status(403).json({ error: "Contratto non autorizzato" });
    }

    const erroreAntiAbuso = await verificaAntiAbusoBonus(to, data, from, deviceId);
    if (erroreAntiAbuso) {
      return res.status(403).json({ error: erroreAntiAbuso });
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, relayerWallet);
    const forwardRequest = {
      from,
      to,
      value: 0,
      gas: gas || 500000,
      nonce: parseInt(nonce || "0"),
      data
    };
    const isValid = await forwarder.verify(forwardRequest, signature);
    if (!isValid) {
      return res.status(400).json({ error: "Firma non valida" });
    }
    const feeData = await provider.getFeeData();
    const minPriorityFee = ethers.utils.parseUnits("30", "gwei");
    const minMaxFee = ethers.utils.parseUnits("100", "gwei");
    const priorityFee = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFee)
      ? feeData.maxPriorityFeePerGas.mul(2)
      : minPriorityFee;
    const maxFee = feeData.maxFeePerGas && feeData.maxFeePerGas.gt(minMaxFee)
      ? feeData.maxFeePerGas.mul(2)
      : minMaxFee;
    const tx = await forwarder.execute(forwardRequest, signature, {
      gasLimit: 600000,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      type: 2
    });

    // IMPORTANTE: aspettiamo (await) il tentativo di notifica prima di rispondere.
    // In ambiente serverless, se rispondessimo prima, la funzione potrebbe essere
    // congelata subito dopo la risposta, uccidendo l'invio della notifica a metà.
    await notificaDestinatarioSePossibile(to, data, tx.hash);
    await registraDispositivoBonus(to, data, from, deviceId);

    return res.status(200).json({
      success: true,
      txHash: tx.hash
    });
  } catch (error) {
    console.error("Relayer error:", error.message);
    return res.status(500).json({
      error: "Errore relayer",
      details: error.message
    });
  }
}
