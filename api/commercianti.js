const { ethers } = require("ethers");

// --- Indirizzi Polygon Mainnet (v8) ---
const PICC_TOKEN_ADDRESS = "0x2254a5067f212E1118c4D0C34D819a78f8528Ca5";

// ABI minimo: solo cio' che serve a questo endpoint.
// - isCommerciante / owner: letture di verifica
// - setCommerciante: scrittura onlyOwner (registra/rimuove un commerciante)
const TOKEN_ABI = [
  "function isCommerciante(address) view returns (bool)",
  "function owner() view returns (address)",
  "function setCommerciante(address commerciante, bool stato)"
];

// --- Firebase Admin (stesso schema protetto usato in relay.js) ---
// Se firebase-admin non si carica o la chiave non e' valida, l'anagrafica si
// disattiva da sola ma le operazioni on-chain continuano a funzionare.
let firestoreDb = null;
let fieldValueRef = null;
try {
  const { initializeApp, getApps, cert } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  }
  firestoreDb = getFirestore();
  fieldValueRef = FieldValue;
} catch (e) {
  console.error("Firebase Admin non disponibile, anagrafica commercianti disattivata:", e.message);
  firestoreDb = null;
}

/**
 * Legge l'anagrafica dei commercianti da Firestore (collection "commercianti")
 * e affianca a ciascuno lo stato reale on-chain (isCommerciante). Cosi' dalla
 * dashboard si vede subito se anagrafica e blockchain sono allineate.
 */
async function elencaCommercianti(token) {
  const anagrafica = [];
  if (firestoreDb) {
    const snap = await firestoreDb.collection("commercianti").get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      anagrafica.push({
        indirizzo: doc.id,
        nome: d.nome || "",
        partitaIva: d.partitaIva || "",
        registratoIl: d.registratoIl || null,
        aggiornatoIl: d.aggiornatoIl || null,
        rimossoIl: d.rimossoIl || null
      });
    });
  }

  // Verifica on-chain in parallelo dello stato di ogni indirizzo in anagrafica.
  const conStato = await Promise.all(
    anagrafica.map(async (c) => {
      let attivoOnChain = null; // null = non verificabile (errore RPC puntuale)
      try {
        attivoOnChain = await token.isCommerciante(c.indirizzo);
      } catch (e) {
        console.error(`Errore lettura isCommerciante per ${c.indirizzo}:`, e.message);
      }
      return { ...c, attivoOnChain };
    })
  );

  // Ordina per nome attivita' (poi per indirizzo) per una lista stabile.
  conStato.sort((a, b) =>
    (a.nome || "").localeCompare(b.nome || "") || a.indirizzo.localeCompare(b.indirizzo)
  );
  return conStato;
}

/**
 * Esegue setCommerciante on-chain col wallet OWNER (deployer). La chiave resta
 * solo lato server, come RELAYER_PRIVATE_KEY: non viene mai esposta al browser.
 * Gestione fee identica a relay.js (Polygon richiede priority fee alta).
 */
async function scriviCommercianteOnChain(provider, indirizzo, stato) {
  const chiaveOwner = (process.env.OWNER_PRIVATE_KEY || "").trim();
  if (!chiaveOwner) {
    throw new Error("OWNER_PRIVATE_KEY non impostata o vuota");
  }
  // Controllo di formato senza mai esporre il valore: una chiave privata valida
  // e' "0x" + 64 caratteri esadecimali (66 caratteri totali).
  const formatoValido = /^0x[0-9a-fA-F]{64}$/.test(chiaveOwner);
  if (!formatoValido) {
    throw new Error(
      `OWNER_PRIVATE_KEY ha un formato non valido (lunghezza attuale: ${chiaveOwner.length} caratteri, ` +
      `attesi 66 cioe' "0x" + 64 esadecimali). Controlla che non manchi "0x" all'inizio e che non ci siano spazi o a-capo.`
    );
  }
  const ownerWallet = new ethers.Wallet(chiaveOwner, provider);
  const token = new ethers.Contract(PICC_TOKEN_ADDRESS, TOKEN_ABI, ownerWallet);

  // Salvaguardia: verifica che questa chiave sia davvero l'owner del contratto,
  // cosi' un errore di configurazione da' un messaggio chiaro invece di una revert.
  const ownerOnChain = await token.owner();
  if (ownerOnChain.toLowerCase() !== ownerWallet.address.toLowerCase()) {
    throw new Error(
      "La chiave OWNER_PRIVATE_KEY non corrisponde all'owner del contratto: " +
      `owner on-chain ${ownerOnChain}, chiave configurata ${ownerWallet.address}`
    );
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

  const tx = await token.setCommerciante(indirizzo, stato, {
    gasLimit: 120000,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priorityFee,
    type: 2
  });
  // Aspettiamo la conferma: in ambiente serverless dobbiamo completare prima di
  // rispondere, altrimenti la funzione puo' essere congelata a meta'.
  const receipt = await tx.wait();
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

/**
 * Verifica se un indirizzo ha mai avuto un movimento PICC reale (in entrata o
 * in uscita), interrogando lo storico completo via API Etherscan V2 (la stessa
 * usata per la fotografia saldi in fase di migrazione v9). Se non ha mai avuto
 * movimenti, è sicuro cancellarlo del tutto (probabile errore di battitura in
 * fase di registrazione); altrimenti va solo disattivato, mantenendo lo storico.
 */
async function haAvutoMovimenti(indirizzo) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    // Senza API key non possiamo verificarlo con certezza: per prudenza,
    // trattiamo come "ha avuto movimenti" (comportamento più sicuro, non
    // cancella mai per errore uno storico che invece andrebbe conservato).
    console.error("ETHERSCAN_API_KEY non configurata: impossibile verificare i movimenti, si procede solo con la disattivazione.");
    return true;
  }
  const url = `https://api.etherscan.io/v2/api?chainid=137&module=account&action=tokentx&contractaddress=${PICC_TOKEN_ADDRESS}&address=${indirizzo}&page=1&offset=1&sort=asc&apikey=${apiKey}`;
  const risposta = await fetch(url);
  const dati = await risposta.json();
  if (dati.status !== "1" || !Array.isArray(dati.result)) {
    // Nessun risultato o errore dell'API: nessun movimento trovato, oppure
    // "No transactions found" — in entrambi i casi trattiamo come "mai avuto movimenti".
    return false;
  }
  return dati.result.length > 0;
}

/**
 * Aggiorna l'anagrafica su Firestore dopo che la scrittura on-chain e' riuscita.
 * Non deve mai far fallire la risposta: l'operazione on-chain e' gia' avvenuta.
 */
async function aggiornaAnagrafica(azione, indirizzo, nome, partitaIva, eliminaDelTutto) {
  try {
    if (!firestoreDb) return;
    const ref = firestoreDb.collection("commercianti").doc(indirizzo);
    if (azione === "aggiungi") {
      const esistente = await ref.get();
      const dati = {
        nome: nome || "",
        partitaIva: partitaIva || "",
        aggiornatoIl: Date.now(),
        // Se stiamo riattivando un indirizzo precedentemente rimosso, ripuliamo
        // il segno di rimozione: altrimenti il badge "RIMOSSO IL..." resterebbe
        // visualizzato per sempre nella dashboard, nonostante sia di nuovo attivo.
        rimossoIl: fieldValueRef ? fieldValueRef.delete() : null
      };
      if (!esistente.exists) dati.registratoIl = Date.now();
      await ref.set(dati, { merge: true });
    } else if (azione === "rimuovi") {
      if (eliminaDelTutto) {
        // Nessun movimento mai registrato: sicuro cancellare del tutto,
        // probabile errore di battitura in fase di registrazione.
        await ref.delete();
      } else {
        // Ha già avuto movimenti reali: manteniamo lo storico, marchiamo
        // solo come rimosso invece di cancellare il documento.
        await ref.set({ rimossoIl: Date.now() }, { merge: true });
      }
    }
  } catch (e) {
    console.error("Errore aggiornamento anagrafica commercianti:", e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-password");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Protezione con password: stesso header della dashboard (status.js).
  const passwordAttesa = process.env.DASHBOARD_PASSWORD;
  const passwordRicevuta = req.headers["x-dashboard-password"];
  if (!passwordAttesa) {
    return res.status(500).json({ error: "Dashboard non configurata: manca DASHBOARD_PASSWORD" });
  }
  if (passwordRicevuta !== passwordAttesa) {
    return res.status(401).json({ error: "Password errata" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const tokenLettura = new ethers.Contract(PICC_TOKEN_ADDRESS, TOKEN_ABI, provider);

    // --- LETTURA: elenco commercianti ---
    if (req.method === "GET") {
      const commercianti = await elencaCommercianti(tokenLettura);
      return res.status(200).json({
        timestamp: new Date().toISOString(),
        commercianti,
        anagraficaDisponibile: firestoreDb !== null
      });
    }

    // --- SCRITTURA: aggiungi / rimuovi / attiva / disattiva / modifica ---
    if (req.method === "POST") {
      const { azione, indirizzo, nome, partitaIva } = req.body || {};

      const azioniValide = ["aggiungi", "rimuovi", "attiva", "disattiva", "modifica"];
      if (!azioniValide.includes(azione)) {
        return res.status(400).json({ error: `Azione non valida: usa una tra ${azioniValide.join(", ")}` });
      }
      if (!indirizzo || !ethers.utils.isAddress(indirizzo)) {
        return res.status(400).json({ error: "Indirizzo Ethereum non valido" });
      }
      // In fase di aggiunta o modifica chiediamo almeno il nome attivita'.
      if ((azione === "aggiungi" || azione === "modifica") && (!nome || !nome.trim())) {
        return res.status(400).json({ error: "Il nome dell'attivita' e' obbligatorio" });
      }

      const indirizzoNorm = ethers.utils.getAddress(indirizzo);

      // --- "modifica": tocca SOLO l'anagrafica Firestore, mai lo stato on-chain ---
      if (azione === "modifica") {
        if (!firestoreDb) {
          return res.status(500).json({ error: "Anagrafica non disponibile (Firestore non configurato)" });
        }
        const ref = firestoreDb.collection("commercianti").doc(indirizzoNorm);
        const esistente = await ref.get();
        if (!esistente.exists) {
          return res.status(404).json({ error: "Nessun commerciante registrato con questo indirizzo da modificare" });
        }
        await ref.set({ nome: nome.trim(), partitaIva: partitaIva || "", aggiornatoIl: Date.now() }, { merge: true });
        return res.status(200).json({ success: true, azione, indirizzo: indirizzoNorm });
      }

      if (!process.env.OWNER_PRIVATE_KEY) {
        return res.status(500).json({
          error: "Chiave owner non configurata: aggiungi OWNER_PRIVATE_KEY nelle variabili d'ambiente Vercel"
        });
      }

      // --- "attiva"/"disattiva": interruttore leggero, SOLO on-chain, non
      // tocca mai lo storico Firestore (nessun rimossoIl, nessuna cancellazione).
      // Pensato per sospendere/riattivare un commerciante senza conseguenze
      // sull'anagrafica, a differenza di "rimuovi" più sotto.
      if (azione === "attiva" || azione === "disattiva") {
        const nuovoStato = azione === "attiva";
        const risultato = await scriviCommercianteOnChain(provider, indirizzoNorm, nuovoStato);
        if (firestoreDb) {
          await firestoreDb.collection("commercianti").doc(indirizzoNorm)
            .set({ aggiornatoIl: Date.now() }, { merge: true })
            .catch((e) => console.error("Errore aggiornamento aggiornatoIl:", e.message));
        }
        return res.status(200).json({
          success: true,
          azione,
          indirizzo: indirizzoNorm,
          txHash: risultato.txHash,
          blockNumber: risultato.blockNumber
        });
      }

      // --- "aggiungi" / "rimuovi": comportamento invariato rispetto a prima ---
      const stato = azione === "aggiungi";

      // Per una rimozione, verifichiamo prima se questo indirizzo ha mai avuto
      // movimenti PICC reali: se no, è sicuro cancellarlo del tutto dall'anagrafica
      // (probabile errore di registrazione); se sì, si disattiva soltanto,
      // mantenendo lo storico.
      let eliminaDelTutto = false;
      if (azione === "rimuovi") {
        eliminaDelTutto = !(await haAvutoMovimenti(indirizzoNorm));
      }

      const risultato = await scriviCommercianteOnChain(provider, indirizzoNorm, stato);
      await aggiornaAnagrafica(azione, indirizzoNorm, nome, partitaIva, eliminaDelTutto);

      return res.status(200).json({
        success: true,
        azione,
        indirizzo: indirizzoNorm,
        eliminatoDelTutto: azione === "rimuovi" ? eliminaDelTutto : undefined,
        txHash: risultato.txHash,
        blockNumber: risultato.blockNumber
      });
    }

    return res.status(405).json({ error: "Metodo non consentito" });
  } catch (error) {
    console.error("Commercianti error:", error.message);
    return res.status(500).json({ error: "Errore gestione commercianti", details: error.message });
  }
};
