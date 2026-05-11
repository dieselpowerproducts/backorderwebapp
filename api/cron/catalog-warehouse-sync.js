const catalogService = require("../../server/services/catalog.service");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!secret) {
    res.status(500).json({ message: "Missing CRON_SECRET configuration." });
    return;
  }

  if (authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ message: "Unauthorized." });
    return;
  }

  try {
    const result = await catalogService.runScheduledWarehouseSync();
    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Something went wrong."
    });
  }
};
