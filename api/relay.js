const { ethers } = require("ethers");

const PICC_TOKEN_ADDRESS   = "0x7168696C997A2CE2Fd05224D79B69C09255085d1";
const PICC_VOUCHER_ADDRESS = "0x430483F0cd869D3Ff2446ce57333d6AFC5592351";
const FORWARDER_ADDRESS    = "0xF6757B82D8ab0cAA74d5C886e93F9EAbDcdC6567";

const FORWARDER_ABI = [
  "function getNonce(address from) view returns (uint256)",
  "function verify((address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data) req, bytes signature) view returns (bool)",
  "function execute((address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data) req, bytes signature) payable returns (bool, bytes)"
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { from, to, data, signature } = req.body;

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

    const nonce = await forwarder.getNonce(from);

    const forwardRequest = {
      from,
      to,
      value: 0,
      gas: 500000,
      nonce: nonce.toNumber(),
      data
    };

    const isValid = await forwarder.verify(forwardRequest, signature);
    if (!isValid) {
      return res.status(400).json({ error: "Firma non valida" });
    }

    const tx = await forwarder.execute(forwardRequest, signature, {
      gasLimit: 600000,
      maxFeePerGas: ethers.utils.parseUnits("200", "gwei"),
      maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei")
    });
    // Non aspettiamo la conferma — restituiamo subito il txHash
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
