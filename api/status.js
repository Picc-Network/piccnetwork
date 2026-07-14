const { ethers } = require("ethers");

const PICC_TOKEN_ADDRESS = "0x2254a5067f212E1118c4D0C34D819a78f8528Ca5";
const DEPLOYER_ADDRESS   = "0xe4913dd350e8F503247e337573b4019450E00d5B";
const TREASURY_ADDRESS   = "0x1325e58A809717dc21397AB32a1A1C716f1cA884";
const RISERVA_ADDRESS    = "0x47bF65b4f464053534EF33a55C7077eD9A57ce3C";

const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)"];

// Soglie minime di allarme (in POL) sotto le quali conviene ricaricare il wallet
const SOGLIA_POL_RELAYER = 5;
const SOGLIA_POL_DEPLOYER = 1;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Protezione con password: senza la password giusta nell'header, nessun dato.
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

    // L'indirizzo del relayer si ricava dalla chiave privata solo qui, lato server:
    // non viene mai esposta, solo il suo saldo pubblico.
    const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY);
    const relayerAddress = relayerWallet.address;

    const [relayerPolWei, deployerPolWei, treasuryPolWei, blockNumber] = await Promise.all([
      provider.getBalance(relayerAddress),
      provider.getBalance(DEPLOYER_ADDRESS),
      provider.getBalance(TREASURY_ADDRESS),
      provider.getBlockNumber()
    ]);

    const token = new ethers.Contract(PICC_TOKEN_ADDRESS, TOKEN_ABI, provider);
    const [treasuryPiccWei, deployerPiccWei, riservaPiccWei, riservaPolWei] = await Promise.all([
      token.balanceOf(TREASURY_ADDRESS),
      token.balanceOf(DEPLOYER_ADDRESS),
      token.balanceOf(RISERVA_ADDRESS),
      provider.getBalance(RISERVA_ADDRESS)
    ]);

    const relayerPol = parseFloat(ethers.utils.formatEther(relayerPolWei));
    const deployerPol = parseFloat(ethers.utils.formatEther(deployerPolWei));
    const treasuryPol = parseFloat(ethers.utils.formatEther(treasuryPolWei));
    const treasuryPicc = parseFloat(ethers.utils.formatUnits(treasuryPiccWei, 18));
    const deployerPicc = parseFloat(ethers.utils.formatUnits(deployerPiccWei, 18));
    const riservaPicc = parseFloat(ethers.utils.formatUnits(riservaPiccWei, 18));
    const riservaPol = parseFloat(ethers.utils.formatEther(riservaPolWei));

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      network: "Polygon Mainnet",
      blockNumber,
      wallets: {
        relayer: {
          address: relayerAddress,
          pol: relayerPol,
          soglia: SOGLIA_POL_RELAYER,
          allarme: relayerPol < SOGLIA_POL_RELAYER,
          descrizione: "Paga il gas di ogni transazione gasless (invii, voucher, pagamenti). Se si esaurisce, TUTTE le transazioni dell'app si bloccano."
        },
        deployer: {
          address: DEPLOYER_ADDRESS,
          pol: deployerPol,
          picc: deployerPicc,
          soglia: SOGLIA_POL_DEPLOYER,
          allarme: deployerPol < SOGLIA_POL_DEPLOYER,
          descrizione: "Usato solo per il deploy o l'aggiornamento dei contratti, non serve per l'uso quotidiano dell'app."
        },
        treasury: {
          address: TREASURY_ADDRESS,
          pol: treasuryPol,
          picc: treasuryPicc,
          descrizione: "Wallet personale del founder — raccoglie anche l'1% di commissione sui trasferimenti PICC."
        },
        riservaIncentivi: {
          address: RISERVA_ADDRESS,
          pol: riservaPol,
          picc: riservaPicc,
          descrizione: "Riserva PICC per bonus, campagne di adozione e liquidità del network. Non usato per il gas, gestito solo da script dedicati."
        }
      },
      linkEsterni: {
        alchemyDashboard: "https://dashboard.alchemy.com",
        vercelDashboard: "https://vercel.com/picc-network1/piccnetwork",
        firebaseConsole: "https://console.firebase.google.com",
        polygonscanRelayer: `https://polygonscan.com/address/${relayerAddress}`,
        polygonscanDeployer: `https://polygonscan.com/address/${DEPLOYER_ADDRESS}`,
        polygonscanTreasury: `https://polygonscan.com/address/${TREASURY_ADDRESS}`,
        polygonscanRiserva: `https://polygonscan.com/address/${RISERVA_ADDRESS}`
      }
    });
  } catch (error) {
    console.error("Status error:", error.message);
    return res.status(500).json({ error: "Errore lettura stato", details: error.message });
  }
}
