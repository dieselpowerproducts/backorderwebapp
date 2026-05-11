const statusService = require("../services/status.service");
const catalogService = require("../services/catalog.service");

async function getVersion(req, res, next) {
  try {
    res.set("Cache-Control", "private, max-age=3600, stale-while-revalidate=300");
    res.send(statusService.getVersionStatus());
  } catch (err) {
    next(err);
  }
}

async function getCatalogSyncStatus(req, res, next) {
  try {
    res.set("Cache-Control", "no-store, max-age=0");
    res.send(await catalogService.getCatalogSyncStatus());
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getCatalogSyncStatus,
  getVersion
};
