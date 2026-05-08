const skunexus = require("./skunexus.service");
const catalogService = require("./catalog.service");
const followUpsService = require("./followUps.service");
const stockCheckEmailsService = require("./stockCheckEmails.service");
const vendorSettingsService = require("./vendorSettings.service");

const enabledVendorStockQuantity = 999999;
const disabledVendorStockQuantity = 0;
const activeAssignedVendorProductStatus = 1;

function normalizeRequiredString(value, message) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function cleanPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  );
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function normalizeStockQuantity(value) {
  const quantity = Number(value);

  return Number.isFinite(quantity) && quantity > 0
    ? enabledVendorStockQuantity
    : disabledVendorStockQuantity;
}

function formatCsvValue(value) {
  const normalized = String(value ?? "");

  if (/[",\r\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  return normalized;
}

function graphqlString(value) {
  return JSON.stringify(String(value || ""));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchSkuNexusVendorProductAssignment({
  vendorId,
  productId,
  productSku
}) {
  const data = await skunexus.query(`
    query V1Queries {
      vendorProduct {
        grid(
          filter: {
            vendor_id: { operator: eq, value: [${graphqlString(vendorId)}] }
            product: { sku: { operator: eq, value: [${graphqlString(productSku)}] } }
          }
          limit: { size: 25, page: 1 }
        ) {
          rows {
            id
            vendor_id
            product_id
            sku
            label
            quantity
            status
            price
          }
        }
      }
    }
  `);

  return (data?.vendorProduct?.grid?.rows || []).find(
    (row) =>
      String(row?.vendor_id || "") === vendorId &&
      String(row?.product_id || "") === productId
  );
}

async function waitForSkuNexusVendorProductAssignment({
  vendorId,
  productId,
  productSku
}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const vendorProduct = await fetchSkuNexusVendorProductAssignment({
      vendorId,
      productId,
      productSku
    });

    if (vendorProduct) {
      return vendorProduct;
    }

    await delay(750);
  }

  return null;
}

async function createSkuNexusVendorProduct({
  vendorId,
  productId,
  productSku
}) {
  const csvRows = [
    ["product_id", "sku", "quantity", "price", "status"],
    [
      productId,
      productSku,
      enabledVendorStockQuantity,
      0,
      activeAssignedVendorProductStatus
    ]
  ];
  const csv = `${csvRows
    .map((row) => row.map(formatCsvValue).join(","))
    .join("\n")}\n`;

  const result = await skunexus.multipart(
    `/vendors/${encodeURIComponent(vendorId)}/products-import`,
    {
      files: [
        {
          fieldName: "csv",
          filename: "stockbridge-vendor-product.csv",
          contentType: "text/csv",
          content: csv
        }
      ]
    }
  );
  const vendorProduct = await waitForSkuNexusVendorProductAssignment({
    vendorId,
    productId,
    productSku
  });

  if (!vendorProduct) {
    const importedCount = Number(result?.imported_count || 0);
    const error = new Error(
      importedCount > 0
        ? "SKU Nexus accepted the vendor import, but the vendor assignment was not available after refresh."
        : "SKU Nexus did not import this vendor assignment."
    );
    error.statusCode = 502;
    throw error;
  }

  return vendorProduct;
}

async function listProducts(queryParams) {
  return catalogService.listProducts(queryParams);
}

async function listStockCheckProducts(queryParams) {
  return catalogService.listStockCheckProducts(queryParams);
}

async function getProductDetails(sku) {
  return catalogService.getProductDetails(sku);
}

async function refreshProductDetails(sku, options = {}) {
  await catalogService.refreshProductBySku(sku, {
    includeWarehouse: options.includeWarehouse !== false
  });
  return catalogService.getProductDetails(sku);
}

async function assignProductVendor({ sku, vendorId }) {
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const product = await catalogService.getCatalogProductBySku(safeSku);

  if (!product) {
    const error = new Error("Product not found.");
    error.statusCode = 404;
    throw error;
  }

  await catalogService.getVendorDetails(safeVendorId);
  await catalogService.refreshProductBySku(safeSku, {
    includeWarehouse: false
  });

  const existingVendorProduct =
    await catalogService.getCatalogVendorProductByVendorAndSku(
      safeVendorId,
      safeSku
    );

  if (!existingVendorProduct) {
    const productSku = product.sku || safeSku;

    await createSkuNexusVendorProduct({
      vendorId: safeVendorId,
      productId: product.id,
      productSku
    });
  }

  await catalogService.refreshProductBySku(safeSku, {
    includeWarehouse: false
  });

  return catalogService.getProductDetails(safeSku);
}

async function setProductFollowUp({ sku, followUpDate }) {
  const result = await followUpsService.setFollowUp({ sku, followUpDate });

  await stockCheckEmailsService.clearVendorEmailsForSku(result.sku || sku);
  clearProductCaches();

  return result;
}

async function setProductVendorStock({
  sku,
  vendorId,
  vendorProductId,
  enabled
}) {
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const safeVendorProductId = normalizeRequiredString(
    vendorProductId,
    "Vendor product ID is required."
  );

  if (typeof enabled !== "boolean") {
    const error = new Error("Enabled must be true or false.");
    error.statusCode = 400;
    throw error;
  }

  const [product, vendorProduct, vendorSettings] = await Promise.all([
    catalogService.getCatalogProductBySku(safeSku),
    catalogService.getCatalogVendorProductById(safeVendorProductId),
    vendorSettingsService.getVendorSettings(safeVendorId)
  ]);

  if (!product) {
    const error = new Error("Product not found.");
    error.statusCode = 404;
    throw error;
  }

  if (!vendorProduct) {
    const error = new Error("Vendor product not found.");
    error.statusCode = 404;
    throw error;
  }

  if (
    vendorProduct.vendor_id !== safeVendorId ||
    vendorProduct.product_id !== product.id
  ) {
    const error = new Error("Vendor product does not match this product.");
    error.statusCode = 409;
    throw error;
  }

  if (vendorSettings.builtToOrder) {
    const error = new Error(
      "Built-to-order vendors cannot have manual stock overrides."
    );
    error.statusCode = 409;
    throw error;
  }

  const quantity = enabled
    ? enabledVendorStockQuantity
    : disabledVendorStockQuantity;
  const result = await setVendorProductQuantity({
    vendorId: safeVendorId,
    vendorProductId: safeVendorProductId,
    quantity,
    vendorProduct
  });

  return {
    ...result,
    sku: product.sku || safeSku,
    enabled
  };
}

async function setVendorProductQuantity({
  vendorId,
  vendorProductId,
  quantity,
  vendorProduct = null
}) {
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const safeVendorProductId = normalizeRequiredString(
    vendorProductId,
    "Vendor product ID is required."
  );
  const safeQuantity = normalizeStockQuantity(quantity);

  const [resolvedVendorProduct, vendorSettings] = await Promise.all([
    vendorProduct || catalogService.getCatalogVendorProductById(safeVendorProductId),
    vendorSettingsService.getVendorSettings(safeVendorId)
  ]);

  if (!resolvedVendorProduct) {
    const error = new Error("Vendor product not found.");
    error.statusCode = 404;
    throw error;
  }

  if (resolvedVendorProduct.vendor_id !== safeVendorId) {
    const error = new Error("Vendor product does not match this vendor.");
    error.statusCode = 409;
    throw error;
  }

  if (vendorSettings.builtToOrder) {
    const error = new Error(
      "Built-to-order vendors cannot have manual stock overrides."
    );
    error.statusCode = 409;
    throw error;
  }

  const productSku =
    resolvedVendorProduct.sku ||
    resolvedVendorProduct.product_sku ||
    resolvedVendorProduct.label ||
    "";
  const payload = cleanPayload({
    product_id: resolvedVendorProduct.product_id,
    sku: productSku,
    label: resolvedVendorProduct.label || productSku,
    quantity: safeQuantity,
    price: optionalNumber(resolvedVendorProduct.price),
    status: optionalNumber(resolvedVendorProduct.status)
  });

  await skunexus.rest(
    `/vendors/${encodeURIComponent(safeVendorId)}/products/${encodeURIComponent(
      safeVendorProductId
    )}`,
    {
      method: "PUT",
      body: payload
    }
  );

  try {
    const updatedVendorProduct =
      await catalogService.updateCatalogVendorProductQuantity(
        safeVendorProductId,
        safeQuantity
      );

    if (!updatedVendorProduct) {
      console.warn(
        "Catalog vendor product was not found after a successful SKU Nexus stock update.",
        {
          sku: productSku,
          vendorId: safeVendorId,
          vendorProductId: safeVendorProductId
        }
      );
    }
  } catch (error) {
    console.error(
      "Unable to update the local catalog vendor product after a successful SKU Nexus stock update.",
      error
    );
  }

  clearProductCaches();

  return {
    sku: resolvedVendorProduct.product_sku || productSku,
    vendorId: safeVendorId,
    vendorProductId: safeVendorProductId,
    quantity: safeQuantity,
    enabled: safeQuantity > 0
  };
}

function clearProductCaches() {
  catalogService.clearCaches();
}

module.exports = {
  assignProductVendor,
  clearProductCaches,
  getProductDetails,
  listProducts,
  listStockCheckProducts,
  refreshProductDetails,
  setProductFollowUp,
  setProductVendorStock,
  setVendorProductQuantity
};
