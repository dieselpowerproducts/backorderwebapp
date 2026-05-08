const { getSql } = require("../db/neon");

let schemaReady;

const inventoryModes = new Set(["numerical", "alphabetical"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeMode(value) {
  const mode = normalizeText(value).toLowerCase();
  return inventoryModes.has(mode) ? mode : "numerical";
}

function parsePhraseList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  return normalizeText(value)
    .split(/[,:]/)
    .map(normalizeText)
    .filter(Boolean);
}

function parseSkuExceptions(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  return normalizeText(value)
    .split(",")
    .map(normalizeText)
    .filter(Boolean);
}

function formatPhraseList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeText).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function assertSettingsInput(input = {}) {
  const enabled = Boolean(input.enabled);
  const senderEmail = normalizeEmail(input.senderEmail);
  const skuHeader = normalizeText(input.skuHeader);
  const inventoryHeader = normalizeText(input.inventoryHeader);
  const subtractiveColumn = normalizeText(input.subtractiveColumn);
  const skuExceptions = parseSkuExceptions(input.skuExceptions);
  const inventoryMode = normalizeMode(input.inventoryMode);
  const inStockPhrases = parsePhraseList(input.inStockPhrases);
  const outOfStockPhrases = parsePhraseList(input.outOfStockPhrases);

  if (enabled) {
    if (!senderEmail) {
      const error = new Error("Inventory sender email is required.");
      error.statusCode = 400;
      throw error;
    }

    if (!skuHeader) {
      const error = new Error("SKU header is required.");
      error.statusCode = 400;
      throw error;
    }

    if (!inventoryHeader) {
      const error = new Error("Inventory header is required.");
      error.statusCode = 400;
      throw error;
    }

    if (inventoryMode === "alphabetical") {
      if (inStockPhrases.length === 0) {
        const error = new Error("Add at least one in stock message.");
        error.statusCode = 400;
        throw error;
      }

      if (outOfStockPhrases.length === 0) {
        const error = new Error("Add at least one out of stock message.");
        error.statusCode = 400;
        throw error;
      }
    }
  }

  return {
    enabled,
    senderEmail,
    skuHeader,
    inventoryHeader,
    subtractiveColumn,
    skuExceptions,
    inventoryMode,
    inStockPhrases,
    outOfStockPhrases
  };
}

function formatSettings(row) {
  return {
    vendorId: normalizeText(row?.vendor_id),
    enabled: Boolean(row?.enabled),
    senderEmail: normalizeEmail(row?.sender_email),
    skuHeader: normalizeText(row?.sku_header),
    inventoryHeader: normalizeText(row?.inventory_header),
    subtractiveColumn: normalizeText(row?.subtractive_column),
    skuExceptions: formatPhraseList(row?.sku_exceptions),
    inventoryMode: normalizeMode(row?.inventory_mode),
    inStockPhrases: formatPhraseList(row?.in_stock_phrases),
    outOfStockPhrases: formatPhraseList(row?.out_of_stock_phrases)
  };
}

async function initializeSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS vendor_auto_inventory_settings (
          vendor_id TEXT PRIMARY KEY,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          sender_email TEXT NOT NULL DEFAULT '',
          sku_header TEXT NOT NULL DEFAULT '',
          inventory_header TEXT NOT NULL DEFAULT '',
          subtractive_column TEXT NOT NULL DEFAULT '',
          sku_exceptions JSONB NOT NULL DEFAULT '[]'::jsonb,
          inventory_mode TEXT NOT NULL DEFAULT 'numerical',
          in_stock_phrases JSONB NOT NULL DEFAULT '[]'::jsonb,
          out_of_stock_phrases JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        ALTER TABLE vendor_auto_inventory_settings
        ADD COLUMN IF NOT EXISTS subtractive_column TEXT NOT NULL DEFAULT ''
      `;
      await sql`
        ALTER TABLE vendor_auto_inventory_settings
        ADD COLUMN IF NOT EXISTS sku_exceptions JSONB NOT NULL DEFAULT '[]'::jsonb
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS vendor_auto_inventory_settings_enabled_idx
        ON vendor_auto_inventory_settings (enabled)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS vendor_auto_inventory_settings_sender_idx
        ON vendor_auto_inventory_settings (sender_email)
      `;
    })();
  }

  return schemaReady;
}

async function getSettings(vendorId) {
  const safeVendorId = normalizeText(vendorId);

  if (!safeVendorId) {
    return formatSettings({ vendor_id: "" });
  }

  await initializeSchema();

  const sql = getSql();
  const rows = await sql`
    SELECT
      vendor_id,
      enabled,
      sender_email,
      sku_header,
      inventory_header,
      subtractive_column,
      sku_exceptions::text AS sku_exceptions,
      inventory_mode,
      in_stock_phrases::text AS in_stock_phrases,
      out_of_stock_phrases::text AS out_of_stock_phrases
    FROM vendor_auto_inventory_settings
    WHERE vendor_id = ${safeVendorId}
    LIMIT 1
  `;

  return formatSettings(rows[0] || { vendor_id: safeVendorId });
}

async function getEnabledSettings() {
  await initializeSchema();

  const sql = getSql();
  const rows = await sql`
    SELECT
      vendor_id,
      enabled,
      sender_email,
      sku_header,
      inventory_header,
      subtractive_column,
      sku_exceptions::text AS sku_exceptions,
      inventory_mode,
      in_stock_phrases::text AS in_stock_phrases,
      out_of_stock_phrases::text AS out_of_stock_phrases
    FROM vendor_auto_inventory_settings
    WHERE enabled = TRUE
    AND sender_email <> ''
    AND sku_header <> ''
    AND inventory_header <> ''
    ORDER BY vendor_id ASC
  `;

  return rows.map(formatSettings);
}

async function saveSettings(vendorId, input = {}) {
  const safeVendorId = normalizeText(vendorId);

  if (!safeVendorId) {
    const error = new Error("Vendor ID is required.");
    error.statusCode = 400;
    throw error;
  }

  const settings = assertSettingsInput(input);

  await initializeSchema();

  const sql = getSql();
  const rows = await sql`
    INSERT INTO vendor_auto_inventory_settings (
      vendor_id,
      enabled,
      sender_email,
      sku_header,
      inventory_header,
      subtractive_column,
      sku_exceptions,
      inventory_mode,
      in_stock_phrases,
      out_of_stock_phrases
    )
    VALUES (
      ${safeVendorId},
      ${settings.enabled},
      ${settings.senderEmail},
      ${settings.skuHeader},
      ${settings.inventoryHeader},
      ${settings.subtractiveColumn},
      ${JSON.stringify(settings.skuExceptions)}::jsonb,
      ${settings.inventoryMode},
      ${JSON.stringify(settings.inStockPhrases)}::jsonb,
      ${JSON.stringify(settings.outOfStockPhrases)}::jsonb
    )
    ON CONFLICT (vendor_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        sender_email = EXCLUDED.sender_email,
        sku_header = EXCLUDED.sku_header,
        inventory_header = EXCLUDED.inventory_header,
        subtractive_column = EXCLUDED.subtractive_column,
        sku_exceptions = EXCLUDED.sku_exceptions,
        inventory_mode = EXCLUDED.inventory_mode,
        in_stock_phrases = EXCLUDED.in_stock_phrases,
        out_of_stock_phrases = EXCLUDED.out_of_stock_phrases,
        updated_at = now()
    RETURNING
      vendor_id,
      enabled,
      sender_email,
      sku_header,
      inventory_header,
      subtractive_column,
      sku_exceptions::text AS sku_exceptions,
      inventory_mode,
      in_stock_phrases::text AS in_stock_phrases,
      out_of_stock_phrases::text AS out_of_stock_phrases
  `;

  return formatSettings(rows[0]);
}

module.exports = {
  getEnabledSettings,
  getSettings,
  initializeSchema,
  saveSettings
};
