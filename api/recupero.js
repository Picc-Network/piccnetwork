import { ethers } from "ethers";
import crypto from "crypto";

// --- Configurazione ---
const CODICE_VALIDITA_MS = 10 * 60 * 1000; // 10 minuti
const CODICE_TENTATIVI_MAX = 5;
const RICHIESTA_CODICE_COOLDOWN_MS = 60 * 1000; // min 1 minuto tra due richieste

// --- Firebase Admin (stesso schema protetto usato in commercianti.js) ---
let firestoreDb = null;
try {
  const { initializeApp, getApps, cert } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { getAuth } = require("firebase-admin/auth");
  const { getMessaging } = require("firebase-admin/messaging");
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  }
  firestoreDb = getFirestore();
  global.__piccAuth = getAuth();
  global.__piccMessaging = getMessaging();
} catch (e) {
  console.error("Firebase Admin non disponibile:", e.message);
  firestoreDb = null;
}

// --- Utilità ---

/** Stessa sanificazione email→ID documento già usata in FirestoreRepository.kt lato app. */
function emailKey(email) {
  return email.trim().toLowerCase().replace(/\./g, "_").replace(/@/g, "_at_");
}

/** Deriva la chiave AES-256 per il backup, combinando un segreto server-side
 * (mai esposto al client) con email e Google UID dell'utente. Il server può
 * ricalcolarla solo dopo aver verificato entrambi i fattori — non la conosce
 * "a riposo", la ricostruisce solo al momento del recupero riuscito. */
function derivaChiaveBackup(email, googleUid) {
  const pepper = process.env.RECOVERY_ENCRYPTION_PEPPER;
  if (!pepper) throw new Error("RECOVERY_ENCRYPTION_PEPPER non configurato");
  return crypto.createHash("sha256").update(`${pepper}:${email.toLowerCase()}:${googleUid}`).digest();
}

function cifraBackup(privateKeyPlain, email, googleUid) {
  const key = derivaChiaveBackup(email, googleUid);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyPlain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decifraBackup(datiCifratiBase64, email, googleUid) {
  const key = derivaChiaveBackup(email, googleUid);
  const combined = Buffer.from(datiCifratiBase64, "base64");
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(12, 28);
  const encrypted = combined.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function generaCodiceOtp() {
  return crypto.randomInt(100000, 999999).toString(); // 6 cifre
}

async function inviaEmailCodice(email, codice) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY non configurato");

  const risposta = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "PICC Network <recupero@piccnetwork.it>",
      to: [email],
      subject: "Il tuo codice di recupero PICC Network",
      html: `
        <p>Hai richiesto di recuperare il tuo wallet PICC Network.</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${codice}</p>
        <p>Questo codice scade tra 10 minuti. Se non hai richiesto tu questo recupero, ignora questa email.</p>
      `
    })
  });

  if (!risposta.ok) {
    const dettaglio = await risposta.text().catch(() => "");
    throw new Error(`Invio email fallito: ${risposta.status} ${dettaglio}`);
  }
}

/** Notifica push al vecchio dispositivo quando il wallet viene migrato altrove.
 * Cerca il token FCM nella collection esistente fcm_tokens/{walletAddress}. */
async function avvisaVecchioDispositivo(walletAddress) {
  try {
    const doc = await firestoreDb.collection("fcm_tokens").doc(walletAddress.toLowerCase()).get();
    if (!doc.exists) return;
    const token = doc.data().token;
    if (!token) return;
    await global.__piccMessaging.send({
      token,
      notification: {
        title: "Wallet attivato su un nuovo dispositivo",
        body: "Se non sei stato tu, contatta subito il supporto PICC Network."
      }
    });
  } catch (e) {
    // Non blocchiamo il recupero se la notifica fallisce: è un avviso di
    // sicurezza aggiuntivo, non una condizione necessaria al recupero stesso.
    console.error("Avviso vecchio dispositivo fallito:", e.message);
  }
}

// --- Handler principale ---

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Metodo non consentito" });

  if (!firestoreDb) {
    return res.status(500).json({ error: "Backend non configurato correttamente (Firestore non disponibile)" });
  }

  const { azione } = req.body || {};

  try {
    // -----------------------------------------------------------------
    // AZIONE 1: registrazione del backup iniziale (una volta, alla
    // creazione del wallet, subito dopo la doppia verifica email+Google).
    // -----------------------------------------------------------------
    if (azione === "registra_backup") {
      const { email, googleIdToken, privateKey, walletAddress, androidId } = req.body;
      if (!email || !googleIdToken || !privateKey || !walletAddress || !androidId) {
        return res.status(400).json({ error: "Parametri mancanti" });
      }

      const decoded = await global.__piccAuth.verifyIdToken(googleIdToken);
      const googleUid = decoded.uid;

      const ref = firestoreDb.collection("utenti").doc(emailKey(email)).collection("recupero").doc("dati");
      const esistente = await ref.get();
      if (esistente.exists) {
        return res.status(409).json({ error: "Un backup di recupero esiste già per questa email. Usa il recupero invece di una nuova registrazione." });
      }

      const chiavePrivataCifrataBackup = cifraBackup(privateKey, email, googleUid);
      await ref.set({
        walletAddress: walletAddress.toLowerCase(),
        googleUid,
        dispositivoAttivo: androidId,
        chiavePrivataCifrataBackup,
        ultimaModifica: Date.now(),
        storicoDispositivi: [{ androidId, tipo: "creazione", timestamp: Date.now() }]
      });

      return res.status(200).json({ success: true });
    }

    // -----------------------------------------------------------------
    // AZIONE 2: richiesta del codice OTP via email (primo passo recupero)
    // -----------------------------------------------------------------
    if (azione === "richiedi_codice") {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email mancante" });

      const ref = firestoreDb.collection("utenti").doc(emailKey(email)).collection("recupero").doc("dati");
      const doc = await ref.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "Nessun wallet registrato con questa email" });
      }

      const dati = doc.data();
      const ora = Date.now();
      if (dati.ultimoInvioCodice && ora - dati.ultimoInvioCodice < RICHIESTA_CODICE_COOLDOWN_MS) {
        return res.status(429).json({ error: "Attendi qualche secondo prima di richiedere un nuovo codice" });
      }

      const codice = generaCodiceOtp();
      await ref.set({
        codiceOtp: codice,
        codiceOtpScadenza: ora + CODICE_VALIDITA_MS,
        codiceOtpTentativi: 0,
        ultimoInvioCodice: ora
      }, { merge: true });

      await inviaEmailCodice(email, codice);

      return res.status(200).json({ success: true });
    }

    // -----------------------------------------------------------------
    // AZIONE 3: verifica doppio fattore (codice + Google) e rilascio chiave
    // -----------------------------------------------------------------
    if (azione === "verifica_e_recupera") {
      const { email, codice, googleIdToken, nuovoAndroidId } = req.body;
      if (!email || !codice || !googleIdToken || !nuovoAndroidId) {
        return res.status(400).json({ error: "Parametri mancanti" });
      }

      const ref = firestoreDb.collection("utenti").doc(emailKey(email)).collection("recupero").doc("dati");
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "Nessun wallet registrato con questa email" });

      const dati = doc.data();

      if (!dati.codiceOtp || !dati.codiceOtpScadenza) {
        return res.status(400).json({ error: "Nessun codice richiesto. Richiedi prima un codice di recupero." });
      }
      if (Date.now() > dati.codiceOtpScadenza) {
        return res.status(400).json({ error: "Codice scaduto. Richiedine uno nuovo." });
      }
      if ((dati.codiceOtpTentativi || 0) >= CODICE_TENTATIVI_MAX) {
        return res.status(429).json({ error: "Troppi tentativi falliti. Richiedi un nuovo codice." });
      }
      if (dati.codiceOtp !== String(codice).trim()) {
        await ref.set({ codiceOtpTentativi: (dati.codiceOtpTentativi || 0) + 1 }, { merge: true });
        return res.status(401).json({ error: "Codice errato" });
      }

      // Codice corretto: verifica ora il secondo fattore (Google Sign-In)
      const decoded = await global.__piccAuth.verifyIdToken(googleIdToken);
      const googleUid = decoded.uid;
      if (googleUid !== dati.googleUid) {
        return res.status(401).json({ error: "L'account Google non corrisponde a quello registrato per questo wallet" });
      }

      // Entrambi i fattori verificati: decifra e rilascia la chiave
      const privateKeyPlain = decifraBackup(dati.chiavePrivataCifrataBackup, email, googleUid);
      const vecchioAndroidId = dati.dispositivoAttivo;

      const storico = Array.isArray(dati.storicoDispositivi) ? dati.storicoDispositivi : [];
      storico.push({ androidId: nuovoAndroidId, tipo: "recupero", timestamp: Date.now() });

      await ref.set({
        dispositivoAttivo: nuovoAndroidId,
        storicoDispositivi: storico,
        ultimaModifica: Date.now(),
        // Il codice è mono-uso: lo invalidiamo subito dopo l'utilizzo riuscito.
        codiceOtp: null,
        codiceOtpScadenza: null,
        codiceOtpTentativi: 0
      }, { merge: true });

      if (vecchioAndroidId && vecchioAndroidId !== nuovoAndroidId) {
        await avvisaVecchioDispositivo(dati.walletAddress);
      }

      return res.status(200).json({
        success: true,
        privateKey: privateKeyPlain,
        walletAddress: dati.walletAddress
      });
    }

    return res.status(400).json({ error: "Azione non riconosciuta" });
  } catch (error) {
    console.error("Recupero error:", error.message);
    return res.status(500).json({ error: "Errore nel sistema di recupero", details: error.message });
  }
}
