const shopifyService = require("../services/shopify.service");

async function resolveOrder(req, res, next) {
  try {
    const order = await shopifyService.resolveOrder({
      createdAt: req.body.createdAt,
      orderNumber: req.body.orderNumber,
      customerEmail: req.body.customerEmail,
      skus: req.body.skus
    });

    res.send({ order });
  } catch (err) {
    next(err);
  }
}

async function updateProductAvailability(req, res, next) {
  try {
    const result = await shopifyService.updateProductAvailability({
      sku: req.body.sku,
      availability: req.body.availability,
      buildToOrderMessage: req.body.buildToOrderMessage,
      followUpDate: req.body.followUpDate,
      productName: req.body.productName
    });

    res.send(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  resolveOrder,
  updateProductAvailability
};
