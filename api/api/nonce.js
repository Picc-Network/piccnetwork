const { ethers } = require("ethers");

const FORWARDER_ADDRESS = "0xF6757B82D8ab0cAA74d5C886e93F9EAbDcdC6567";

const FORWARDER_ABI = [
  "function getNonce(address from) view returns (uint256)"
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "Address richiesto" });

  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, provider);
    const nonce = await forwarder.getNonce(address);
    return res.status(200).json({ nonce: nonce.toString() });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
