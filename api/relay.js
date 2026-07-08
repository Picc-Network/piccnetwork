const { ethers } = require("ethers");

const PICC_TOKEN_ADDRESS   = "0x68fE48D67d9768ADd1Ee5290C2e513431eD67B66";
const PICC_VOUCHER_ADDRESS = "0x4B7b25169a08a4470de4bA175B8856Bf4B27eD80";
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
    const { from, to, data, signature, nonce, gas } = req.body;
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
