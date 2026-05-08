const express = require("express");
const statusController = require("../controllers/status.controller");

const router = express.Router();

router.get("/status/catalog-sync", statusController.getCatalogSyncStatus);
router.get("/status/version", statusController.getVersion);

module.exports = router;
