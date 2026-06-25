const express = require("express");
const shopifyController = require("../controllers/shopify.controller");

const router = express.Router();

router.post("/shopify/orders/resolve", shopifyController.resolveOrder);
router.post(
  "/shopify/products/availability",
  shopifyController.updateProductAvailability
);

module.exports = router;
