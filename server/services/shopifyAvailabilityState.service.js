const { getSql } = require("../db/neon");

const availabilityStatuses = new Set([
  "in_stock",
  "out_of_stock",
  "backordered",
  "built_to_order"
]);

let schemaReady;

function normalizeSku(value) {
  return String(value || "").trim();
}

function normalizeAvailabilityStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  return availabilityStatuses.has(normalized) ? normalized : "";
}

function assertSku(sku) {
  if (!normalizeSku(sku)) {
    const error = new Error("Product SKU is required.");
    error.statusCode = 400;
    throw error;
  }
}

async function initializeSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS product_shopify_availability_state (
          sku TEXT PRIMARY KEY,
          availability_status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })();
  }

  return schemaReady;
}

async function getAvailabilityStatusForSku(sku) {
  assertSku(sku);
  await initializeSchema();

  const sql = getSql();
  const safeSku = normalizeSku(sku);
  const rows = await sql`
    SELECT availability_status
    FROM product_shopify_availability_state
    WHERE sku = ${safeSku}
    LIMIT 1
  `;

  return normalizeAvailabilityStatus(rows[0]?.availability_status);
}

async function setAvailabilityStatus({ sku, availability }) {
  assertSku(sku);
  const safeAvailability = normalizeAvailabilityStatus(availability);

  if (!safeAvailability) {
    const error = new Error("Shopify availability status is invalid.");
    error.statusCode = 400;
    throw error;
  }

  await initializeSchema();

  const sql = getSql();
  const safeSku = normalizeSku(sku);
  const rows = await sql`
    INSERT INTO product_shopify_availability_state (sku, availability_status)
    VALUES (${safeSku}, ${safeAvailability})
    ON CONFLICT (sku) DO UPDATE
    SET availability_status = EXCLUDED.availability_status,
        updated_at = now()
    RETURNING availability_status
  `;

  return normalizeAvailabilityStatus(rows[0]?.availability_status);
}

module.exports = {
  getAvailabilityStatusForSku,
  setAvailabilityStatus
};
