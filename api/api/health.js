export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    service: "PICC Network Relayer v3",
    network: "Polygon Mainnet (Chain ID 137)",
    contracts: {
      piccForwarder: "0xF6757B82D8ab0cAA74d5C886e93F9EAbDcdC6567",
      piccToken:     "0x7168696C997A2CE2Fd05224D79B69C09255085d1",
      piccVoucher:   "0x430483F0cd869D3Ff2446ce57333d6AFC5592351"
    }
  });
}
