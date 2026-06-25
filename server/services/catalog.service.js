const { getSql } = require("../db/neon");
const followUpsService = require("./followUps.service");
const shopifyAvailabilityStateService = require("./shopifyAvailabilityState.service");
const skunexus = require("./skunexus.service");
const stockCheckEmailsService = require("./stockCheckEmails.service");
const vendorSettingsService = require("./vendorSettings.service");

const fullSyncPageSize = 1000;
const productFetchConcurrency = 4;
const stockCheckCacheTtlMs = 5 * 60 * 1000;
const dppWarehouseLabel = "DPP Warehouse";
const dppWarehouseStockType = "WAREHOUSE";
const syncTimezone = process.env.CATALOG_SYNC_TIMEZONE || "America/Los_Angeles";
const warehouseSyncStartHour = 6;
const warehouseSyncEndHour = 20;
const stockCheckSortValues = new Set([
  "all",
  "yesterday",
  "today",
  "tomorrow",
  "no-follow-up"
]);
const productSelectionFields = `
  id
  sku
  name
  state
  qty_available
  is_kit
  relatedProduct {
    sku
    name
    qty
  }
`;

let schemaReady;
let fullSyncPromise = null;
let warehouseSyncPromise = null;
const productRefreshPromises = new Map();
const stockCheckCache = new Map();

function normalizePaging({ page = 1, limit = 50 } = {}) {
  return {
    page: Math.max(Number.parseInt(page, 10) || 1, 1),
    limit: Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100)
  };
}

function normalizeSearch(search) {
  return String(search || "").trim();
}

function normalizeProductState(state) {
  return String(state || "Active").trim() || "Active";
}

function normalizeStockCheckSort(sort) {
  const normalized = String(sort || "all").trim().toLowerCase();
  return stockCheckSortValues.has(normalized) ? normalized : "all";
}

function normalizeDateText(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return new Date().toISOString().slice(0, 10);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error("Reference date must use YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeBoolean(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function normalizeRequiredString(value, message) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function parseDateText(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== String(value)
  ) {
    const error = new Error("Reference date is invalid.");
    error.statusCode = 400;
    throw error;
  }

  return date;
}

function formatDateText(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysToDateText(value, days) {
  const date = parseDateText(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateText(date);
}

function emptyProductsResponse() {
  return {
    data: [],
    total: 0,
    totalPages: 0,
    isLastPage: true
  };
}

function paginateRows(rows, { page, limit }) {
  const total = rows.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;

  return {
    data: rows.slice(start, start + limit),
    total,
    totalPages,
    isLastPage: totalPages === 0 || page >= totalPages
  };
}

function graphqlString(value) {
  return JSON.stringify(String(value || ""));
}

function graphqlStringList(values) {
  return values.map(graphqlString).join(", ");
}

function normalizeKitChild(row) {
  const sku = String(row?.sku || "").trim();

  if (!sku) {
    return null;
  }

  return {
    sku,
    name: row?.name || sku,
    qty: Math.max(Number(row?.qty || row?.qty_required || 0), 1)
  };
}

function normalizeProductNode(row) {
  const sku = String(row?.sku || "").trim();

  if (!sku) {
    return null;
  }

  return {
    id: row?.id || row?.product_id || "",
    sku,
    name: row?.name || sku,
    state: normalizeProductState(row?.state),
    qty_available: Math.max(
      Number(row?.warehouse_qty_available ?? row?.qty_available ?? 0),
      0
    ),
    is_kit: Boolean(row?.is_kit),
    relatedProduct: (row?.relatedProduct || [])
      .map(normalizeKitChild)
      .filter(Boolean)
  };
}

function getKitChildSkus(products) {
  return Array.from(
    new Set(
      products.flatMap((product) =>
        (product?.relatedProduct || []).map((child) => child.sku).filter(Boolean)
      )
    )
  );
}

function getUnavailableAvailability(hasBuiltToOrderVendor) {
  return hasBuiltToOrderVendor ? "Built to Order" : "Backorder";
}

function mapAvailability(qtyAvailable, hasActiveVendor, hasBuiltToOrderVendor = false) {
  if (Number(qtyAvailable || 0) > 0 || !hasActiveVendor) {
    return "Available";
  }

  return getUnavailableAvailability(hasBuiltToOrderVendor);
}

function isActiveVendor(vendor) {
  return Number(vendor?.status || 0) >= 2;
}

function getEffectiveQtyAvailable(
  sku,
  productsBySku,
  qtyCache = new Map(),
  visiting = new Set(),
  productVendorAvailability = null
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return 0;
  }

  if (qtyCache.has(safeSku)) {
    return qtyCache.get(safeSku);
  }

  const product = productsBySku.get(safeSku);

  if (!product) {
    qtyCache.set(safeSku, 0);
    return 0;
  }

  const vendorQtyAvailable = getVendorQtyAvailable(product, productVendorAvailability);

  if (vendorQtyAvailable > 0) {
    qtyCache.set(safeSku, vendorQtyAvailable);
    return vendorQtyAvailable;
  }

  if (!product.is_kit || product.relatedProduct.length === 0) {
    const qtyAvailable = product.is_kit
      ? 0
      : Math.max(product.qty_available, vendorQtyAvailable);
    qtyCache.set(safeSku, qtyAvailable);
    return qtyAvailable;
  }

  if (visiting.has(safeSku)) {
    qtyCache.set(safeSku, 0);
    return 0;
  }

  visiting.add(safeSku);
  const childQtyAvailable = product.relatedProduct.map((child) => {
    const requiredQty = Math.max(Number(child.qty || 0), 1);
    const childQty = getEffectiveQtyAvailable(
      child.sku,
      productsBySku,
      qtyCache,
      visiting,
      productVendorAvailability
    );

    return Math.floor(childQty / requiredQty);
  });
  visiting.delete(safeSku);

  const qtyAvailable =
    childQtyAvailable.length > 0 ? Math.min(...childQtyAvailable) : 0;
  qtyCache.set(safeSku, qtyAvailable);

  return qtyAvailable;
}

function hasActiveVendor(product, productVendorAvailability) {
  return Boolean(
    product?.id &&
      productVendorAvailability?.productIdsWithActiveVendors?.has(product.id)
  );
}

function hasBuiltToOrderVendor(product, productVendorAvailability) {
  return Boolean(
    product?.id &&
      productVendorAvailability?.productIdsWithBuiltToOrderVendors?.has(product.id)
  );
}

function getVendorQtyAvailable(product, productVendorAvailability) {
  if (!product?.id || !productVendorAvailability?.vendorQuantityByProductId) {
    return 0;
  }

  return Math.max(
    Number(productVendorAvailability.vendorQuantityByProductId.get(product.id) || 0),
    0
  );
}

function getEffectiveAvailability(
  sku,
  productsBySku,
  productVendorAvailability,
  availabilityCache = new Map(),
  visiting = new Set()
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return "Backorder";
  }

  if (availabilityCache.has(safeSku)) {
    return availabilityCache.get(safeSku);
  }

  const product = productsBySku.get(safeSku);

  if (!product) {
    availabilityCache.set(safeSku, "Backorder");
    return "Backorder";
  }

  const qtyAvailable = Math.max(
    product.is_kit ? 0 : product.qty_available,
    getVendorQtyAvailable(product, productVendorAvailability)
  );

  if (qtyAvailable > 0) {
    availabilityCache.set(safeSku, "Available");
    return "Available";
  }

  if (!product.is_kit || product.relatedProduct.length === 0) {
    const availability = mapAvailability(
      qtyAvailable,
      hasActiveVendor(product, productVendorAvailability),
      hasBuiltToOrderVendor(product, productVendorAvailability)
    );

    availabilityCache.set(safeSku, availability);
    return availability;
  }

  if (visiting.has(safeSku)) {
    availabilityCache.set(safeSku, "Backorder");
    return "Backorder";
  }

  visiting.add(safeSku);
  const childAvailabilities = product.relatedProduct.map((child) =>
    getEffectiveAvailability(
      child.sku,
      productsBySku,
      productVendorAvailability,
      availabilityCache,
      visiting
    )
  );
  visiting.delete(safeSku);

  const availability = childAvailabilities.includes("Backorder")
    ? "Backorder"
    : childAvailabilities.includes("Built to Order")
      ? "Built to Order"
      : childAvailabilities.length > 0
        ? "Available"
        : "Backorder";

  availabilityCache.set(safeSku, availability);
  return availability;
}

function matchesProductSearch(product, search) {
  if (!search) {
    return true;
  }

  const terms = String(search)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const haystack = [product?.sku, product?.name]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  return terms.every((term) => haystack.includes(term));
}

function compareStockCheckProducts(left, right) {
  const leftDate = String(left?.followUpDate || "");
  const rightDate = String(right?.followUpDate || "");

  if (leftDate && rightDate && leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  if (leftDate && !rightDate) {
    return -1;
  }

  if (!leftDate && rightDate) {
    return 1;
  }

  return String(left?.sku || "").localeCompare(String(right?.sku || ""), undefined, {
    sensitivity: "base"
  });
}

function filterStockCheckProducts(products, sort, referenceDate) {
  if (sort === "all") {
    return [...products].sort(compareStockCheckProducts);
  }

  if (sort === "no-follow-up") {
    return products
      .filter((product) => !product.followUpDate)
      .sort(compareStockCheckProducts);
  }

  const offsetBySort = {
    yesterday: -1,
    today: 0,
    tomorrow: 1
  };
  const targetDate = addDaysToDateText(referenceDate, offsetBySort[sort] || 0);

  return products
    .filter((product) => product.followUpDate === targetDate)
    .sort(compareStockCheckProducts);
}

function getTimeZoneDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    localDate: `${byType.year}-${byType.month}-${byType.day}`,
    localHour: Number.parseInt(byType.hour || "0", 10) || 0
  };
}

function flattenProductComponents(products) {
  return products.flatMap((product) =>
    (product?.relatedProduct || [])
      .map(normalizeKitChild)
      .filter(Boolean)
      .map((child) => ({
        parent_product_id: String(product.id || product.product_id || "").trim(),
        child_sku: child.sku,
        child_name: child.name || child.sku,
        qty_required: Math.max(Number(child.qty || 0), 1)
      }))
  );
}

function dedupeRows(rows, keySelector) {
  const rowsByKey = new Map();

  for (const row of rows) {
    const key = String(keySelector(row) || "").trim();

    if (key) {
      rowsByKey.set(key, row);
    }
  }

  return Array.from(rowsByKey.values());
}

function normalizeProductRow(row) {
  return {
    product_id: String(row?.id || row?.product_id || "").trim(),
    sku: String(row?.sku || "").trim(),
    name: String(row?.name || "").trim(),
    state: normalizeProductState(row?.state),
    qty_available: Math.max(Number(row?.qty_available || 0), 0),
    is_kit: Boolean(row?.is_kit),
    relatedProduct: Array.isArray(row?.relatedProduct) ? row.relatedProduct : []
  };
}

function isWarehouseSyncWindow(localHour) {
  return localHour >= warehouseSyncStartHour && localHour < warehouseSyncEndHour;
}

function normalizeVendorRow(row) {
  return {
    vendor_id: String(row?.id || row?.vendor_id || "").trim(),
    name: String(row?.name || "").trim(),
    label: String(row?.label || "").trim(),
    status: Number.parseInt(String(row?.status || 0), 10) || 0
  };
}

function normalizeVendorProductRow(row) {
  return {
    vendor_product_id: String(row?.id || row?.vendor_product_id || "").trim(),
    vendor_id: String(row?.vendor_id || "").trim(),
    product_id: String(row?.product_id || "").trim(),
    sku: String(row?.sku || "").trim(),
    label: String(row?.label || "").trim(),
    quantity: Number(row?.quantity || 0),
    status:
      row?.status === null || row?.status === undefined || row?.status === ""
        ? null
        : Number(row.status),
    price:
      row?.price === null || row?.price === undefined || row?.price === ""
        ? null
        : Number(row.price)
  };
}

function aggregateWarehouseStockRows(rows) {
  const aggregated = new Map();

  for (const row of rows) {
    const productId = String(row?.product?.id || row?.product_id || "").trim();

    if (!productId) {
      continue;
    }

    const existing = aggregated.get(productId) || {
      product_id: productId,
      stock_id: String(row?.id || "").trim(),
      warehouse_label:
        String(row?.location?.warehouse?.label || row?.warehouse_label || "").trim() ||
        dppWarehouseLabel,
      stock_type: String(row?.type || row?.stock_type || "").trim() || dppWarehouseStockType,
      qty: 0,
      qty_available: 0
    };

    existing.qty += Number(row?.qty || 0);
    existing.qty_available += Number(row?.qty_available || 0);

    if (!existing.stock_id) {
      existing.stock_id = String(row?.id || "").trim();
    }

    aggregated.set(productId, existing);
  }

  return Array.from(aggregated.values());
}

async function initializeSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await vendorSettingsService.initializeSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS catalog_products (
          product_id TEXT PRIMARY KEY,
          sku TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'Active',
          qty_available INTEGER NOT NULL DEFAULT 0,
          is_kit BOOLEAN NOT NULL DEFAULT FALSE,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        ALTER TABLE catalog_products
        ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'Active'
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_products_sku_idx
        ON catalog_products (sku)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_products_name_idx
        ON catalog_products (name)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_products_state_idx
        ON catalog_products (state)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_product_components (
          parent_product_id TEXT NOT NULL,
          child_sku TEXT NOT NULL,
          child_name TEXT NOT NULL DEFAULT '',
          qty_required INTEGER NOT NULL DEFAULT 1,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (parent_product_id, child_sku)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_product_components_parent_idx
        ON catalog_product_components (parent_product_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_product_components_child_idx
        ON catalog_product_components (child_sku)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_vendors (
          vendor_id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          status INTEGER NOT NULL DEFAULT 0,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendors_name_idx
        ON catalog_vendors (name)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_vendor_products (
          vendor_product_id TEXT PRIMARY KEY,
          vendor_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          sku TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
          status DOUBLE PRECISION,
          price DOUBLE PRECISION,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_vendor_idx
        ON catalog_vendor_products (vendor_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_product_idx
        ON catalog_vendor_products (product_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_sku_idx
        ON catalog_vendor_products (sku)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_warehouse_stock (
          product_id TEXT PRIMARY KEY,
          stock_id TEXT NOT NULL DEFAULT '',
          warehouse_label TEXT NOT NULL DEFAULT '',
          stock_type TEXT NOT NULL DEFAULT '',
          qty DOUBLE PRECISION NOT NULL DEFAULT 0,
          qty_available DOUBLE PRECISION NOT NULL DEFAULT 0,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_sync_state (
          sync_key TEXT PRIMARY KEY,
          sync_value TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })();
  }

  return schemaReady;
}

async function getSyncState(key) {
  await initializeSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT sync_value
    FROM catalog_sync_state
    WHERE sync_key = ${key}
  `;

  return String(rows[0]?.sync_value || "");
}

async function setSyncState(key, value) {
  await initializeSchema();
  const sql = getSql();

  await sql`
    INSERT INTO catalog_sync_state (sync_key, sync_value)
    VALUES (${key}, ${String(value || "")})
    ON CONFLICT (sync_key) DO UPDATE
    SET sync_value = EXCLUDED.sync_value,
        updated_at = now()
  `;
}

function buildTermsSearchClause(params, terms, expressions) {
  if (terms.length === 0) {
    return "";
  }

  const index = params.length + 1;
  params.push(JSON.stringify(terms));
  const haystackClause = expressions
    .map((expression) => `lower(coalesce(${expression}, '')) LIKE '%' || lower(term.value) || '%'`)
    .join(" OR ");

  return `
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text($${index}::jsonb) AS term(value)
      WHERE NOT (${haystackClause})
    )
  `;
}

function getSearchTerms(search) {
  return normalizeSearch(search)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

async function queryProductsPage({ page, limit, search }) {
  const sql = getSql();
  const offset = (page - 1) * limit;
  const terms = getSearchTerms(search);
  const baseParams = [];
  const whereClause = buildTermsSearchClause(baseParams, terms, ["p.sku", "p.name"]);
  const countRows = await sql.query(
    `
      SELECT COUNT(*)::int AS count
      FROM catalog_products p
      WHERE lower(COALESCE(p.state, 'Active')) = 'active'
      ${whereClause}
    `,
    baseParams
  );
  const total = Number(countRows[0]?.count || 0);
  const dataParams = [...baseParams, limit, offset];
  const rows = await sql.query(
    `
      SELECT
        p.product_id AS id,
        p.sku,
        p.name,
        p.state,
        p.qty_available,
        p.is_kit
      FROM catalog_products p
      WHERE lower(COALESCE(p.state, 'Active')) = 'active'
      ${whereClause}
      ORDER BY p.sku ASC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `,
    dataParams
  );

  return {
    data: rows,
    total,
    totalPages: Math.ceil(total / limit),
    isLastPage: total === 0 || page >= Math.ceil(total / limit)
  };
}

async function queryAllVendors() {
  const sql = getSql();
  return sql`
    SELECT vendor_id, name, label, status
    FROM catalog_vendors
    ORDER BY COALESCE(NULLIF(name, ''), label, vendor_id) ASC
  `;
}

async function queryVendorById(vendorId) {
  const sql = getSql();
  const rows = await sql`
    SELECT vendor_id, name, label, status
    FROM catalog_vendors
    WHERE vendor_id = ${vendorId}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryVendorProductsPage({ vendorId, page, limit, search }) {
  const sql = getSql();
  const offset = (page - 1) * limit;
  const terms = getSearchTerms(search);
  const baseParams = [vendorId];
  const searchClause = buildTermsSearchClause(baseParams, terms, [
    "vp.sku",
    "vp.label",
    "p.sku",
    "p.name"
  ]);
  const countRows = await sql.query(
    `
      SELECT COUNT(*)::int AS count
      FROM catalog_vendor_products vp
      JOIN catalog_products p
        ON p.product_id = vp.product_id
      WHERE vp.vendor_id = $1
      AND lower(COALESCE(p.state, 'Active')) = 'active'
      ${searchClause}
    `,
    baseParams
  );
  const total = Number(countRows[0]?.count || 0);
  const dataParams = [...baseParams, limit, offset];
  const rows = await sql.query(
    `
      SELECT
        vp.vendor_product_id,
        vp.vendor_id,
        vp.product_id,
        vp.sku,
        vp.label,
        vp.quantity,
        p.sku AS product_sku,
        p.name AS product_name,
        p.qty_available
      FROM catalog_vendor_products vp
      JOIN catalog_products p
        ON p.product_id = vp.product_id
      WHERE vp.vendor_id = $1
      AND lower(COALESCE(p.state, 'Active')) = 'active'
      ${searchClause}
      ORDER BY COALESCE(NULLIF(p.sku, ''), vp.sku, vp.label, vp.vendor_product_id) ASC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `,
    dataParams
  );

  return {
    data: rows,
    total,
    totalPages: Math.ceil(total / limit),
    isLastPage: total === 0 || page >= Math.ceil(total / limit)
  };
}

async function queryProductsBySkus(skus) {
  const uniqueSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  if (uniqueSkus.length === 0) {
    return [];
  }

  const sql = getSql();
  const skuJson = JSON.stringify(uniqueSkus);

  return sql.query(
    `
      SELECT
        product_id AS id,
        sku,
        name,
        state,
        qty_available,
        is_kit
      FROM catalog_products
      WHERE sku IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      AND lower(COALESCE(state, 'Active')) = 'active'
    `,
    [skuJson]
  );
}

async function queryProductsByIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT
        product_id AS id,
        sku,
        name,
        state,
        qty_available,
        is_kit
      FROM catalog_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      AND lower(COALESCE(state, 'Active')) = 'active'
    `,
    [idJson]
  );
}

async function queryProductBySku(sku) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      product_id AS id,
      sku,
      name,
      state,
      qty_available,
      is_kit
    FROM catalog_products
    WHERE sku = ${sku}
    AND lower(COALESCE(state, 'Active')) = 'active'
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryAllProducts() {
  const sql = getSql();
  return sql`
    SELECT
      product_id AS id,
      sku,
      name,
      state,
      qty_available,
      is_kit
    FROM catalog_products
    WHERE lower(COALESCE(state, 'Active')) = 'active'
    ORDER BY sku ASC
  `;
}

async function queryComponentsByParentIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT
        parent_product_id,
        child_sku,
        child_name,
        qty_required
      FROM catalog_product_components
      WHERE parent_product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

async function queryParentKitsByChildSku(childSku) {
  const sql = getSql();
  return sql`
    SELECT
      p.product_id AS id,
      p.sku,
      p.name,
      p.state,
      p.qty_available,
      p.is_kit,
      c.qty_required
    FROM catalog_product_components c
    JOIN catalog_products p
      ON p.product_id = c.parent_product_id
    WHERE c.child_sku = ${childSku}
    AND p.is_kit = TRUE
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    ORDER BY p.sku ASC
  `;
}

async function queryAllComponents() {
  const sql = getSql();
  return sql`
    SELECT
      parent_product_id,
      child_sku,
      child_name,
      qty_required
    FROM catalog_product_components
  `;
}

async function queryVendorProductsByProductId(productId) {
  const sql = getSql();
  return sql`
    SELECT
      vendor_product_id AS id,
      vendor_id,
      product_id,
      sku,
      label,
      quantity,
      status,
      price
    FROM catalog_vendor_products
    WHERE product_id = ${productId}
    ORDER BY COALESCE(NULLIF(sku, ''), label, vendor_product_id) ASC
  `;
}

async function queryActiveVendorProductsByVendorId(vendorId) {
  const sql = getSql();
  return sql`
    SELECT
      vp.vendor_product_id AS id,
      vp.vendor_id,
      vp.product_id,
      vp.sku,
      vp.label,
      vp.quantity,
      vp.status,
      vp.price,
      p.sku AS product_sku,
      p.name AS product_name
    FROM catalog_vendor_products vp
    JOIN catalog_products p
      ON p.product_id = vp.product_id
    WHERE vp.vendor_id = ${vendorId}
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    ORDER BY COALESCE(NULLIF(p.sku, ''), vp.sku, vp.label, vp.vendor_product_id) ASC
  `;
}

async function queryVendorProductById(vendorProductId) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      vp.vendor_product_id AS id,
      vp.vendor_id,
      vp.product_id,
      vp.sku,
      vp.label,
      vp.quantity,
      vp.status,
      vp.price,
      p.sku AS product_sku,
      p.name AS product_name
    FROM catalog_vendor_products vp
    JOIN catalog_products p
      ON p.product_id = vp.product_id
    WHERE vp.vendor_product_id = ${vendorProductId}
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryVendorProductByVendorAndSku(vendorId, sku) {
  const sql = getSql();
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return null;
  }

  const rows = await sql`
    SELECT
      vp.vendor_product_id AS id,
      vp.vendor_id,
      vp.product_id,
      vp.sku,
      vp.label,
      vp.quantity,
      vp.status,
      vp.price,
      p.sku AS product_sku,
      p.name AS product_name
    FROM catalog_vendor_products vp
    JOIN catalog_products p
      ON p.product_id = vp.product_id
    WHERE vp.vendor_id = ${vendorId}
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    AND (
      lower(vp.sku) = lower(${safeSku})
      OR lower(vp.label) = lower(${safeSku})
      OR lower(p.sku) = lower(${safeSku})
    )
    ORDER BY
      CASE
        WHEN lower(p.sku) = lower(${safeSku}) THEN 0
        WHEN lower(vp.sku) = lower(${safeSku}) THEN 1
        WHEN lower(vp.label) = lower(${safeSku}) THEN 2
        ELSE 3
      END ASC,
      vp.vendor_product_id ASC
    LIMIT 1
  `;

  return rows[0] || null;
}

async function updateCatalogVendorProductQuantity(vendorProductId, quantity) {
  const sql = getSql();
  const rows = await sql`
    UPDATE catalog_vendor_products
    SET quantity = ${quantity}
    WHERE vendor_product_id = ${vendorProductId}
    RETURNING
      vendor_product_id AS id,
      vendor_id,
      product_id,
      sku,
      label,
      quantity,
      status,
      price
  `;

  return rows[0] || null;
}

async function queryVendorsByIds(vendorIds) {
  const uniqueIds = Array.from(
    new Set((vendorIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT vendor_id AS id, name, label, status
      FROM catalog_vendors
      WHERE vendor_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

async function queryWarehouseStockByProductId(productId) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      product_id,
      stock_id,
      warehouse_label,
      stock_type,
      qty,
      qty_available
    FROM catalog_warehouse_stock
    WHERE product_id = ${productId}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryWarehouseStockByProductIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);
  const rows = await sql.query(
    `
      SELECT
        product_id,
        COALESCE(SUM(qty_available), 0) AS qty_available
      FROM catalog_warehouse_stock
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      GROUP BY product_id
    `,
    [idJson]
  );

  return new Map(
    rows.map((row) => [
      String(row?.product_id || "").trim(),
      Math.max(Number(row?.qty_available || 0), 0)
    ])
  );
}

async function attachWarehouseQtyToProducts(products) {
  if (products.length === 0) {
    return [];
  }

  const warehouseQtyByProductId = await queryWarehouseStockByProductIds(
    products.map((product) => product.id || product.product_id).filter(Boolean)
  );

  return products.map((product) => {
    const productId = String(product?.id || product?.product_id || "").trim();

    return {
      ...product,
      warehouse_qty_available: warehouseQtyByProductId.get(productId) || 0
    };
  });
}

async function queryVendorAvailabilityRows(productIds) {
  const sql = getSql();

  if (!productIds) {
    return sql`
      SELECT
        vp.product_id,
        vp.vendor_id,
        vp.quantity,
        v.status,
        COALESCE(vs.built_to_order, FALSE) AS built_to_order
      FROM catalog_vendor_products vp
      JOIN catalog_vendors v
        ON v.vendor_id = vp.vendor_id
      LEFT JOIN vendor_settings vs
        ON vs.vendor_id = vp.vendor_id
    `;
  }

  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT
        vp.product_id,
        vp.vendor_id,
        vp.quantity,
        v.status,
        COALESCE(vs.built_to_order, FALSE) AS built_to_order
      FROM catalog_vendor_products vp
      JOIN catalog_vendors v
        ON v.vendor_id = vp.vendor_id
      LEFT JOIN vendor_settings vs
        ON vs.vendor_id = vp.vendor_id
      WHERE vp.product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

function attachComponentsToProducts(products, componentRows) {
  const componentsByProductId = new Map();

  for (const row of componentRows) {
    const parentProductId = String(row?.parent_product_id || "").trim();
    const childSku = String(row?.child_sku || "").trim();

    if (!parentProductId || !childSku) {
      continue;
    }

    const items = componentsByProductId.get(parentProductId) || [];

    items.push({
      sku: childSku,
      name: String(row?.child_name || row?.child_sku || "").trim(),
      qty: Math.max(Number(row?.qty_required || 0), 1)
    });
    componentsByProductId.set(parentProductId, items);
  }

  return products.map((product) => ({
    ...product,
    relatedProduct: componentsByProductId.get(String(product?.id || "").trim()) || []
  }));
}

async function enrichProductsWithComponents(products) {
  if (products.length === 0) {
    return [];
  }

  const componentRows = await queryComponentsByParentIds(
    products.map((product) => product.id).filter(Boolean)
  );

  return attachComponentsToProducts(products, componentRows);
}

async function buildProductGraph(rows) {
  const productsBySku = new Map();
  let nextRows = await attachWarehouseQtyToProducts(
    await enrichProductsWithComponents(rows)
  );

  while (nextRows.length > 0) {
    for (const row of nextRows) {
      const product = normalizeProductNode(row);

      if (product) {
        productsBySku.set(product.sku, product);
      }
    }

    const nextSkus = getKitChildSkus(nextRows).filter((sku) => !productsBySku.has(sku));

    if (nextSkus.length === 0) {
      break;
    }

    const fetchedRows = await queryProductsBySkus(nextSkus);

    if (fetchedRows.length === 0) {
      break;
    }

    nextRows = await attachWarehouseQtyToProducts(
      await enrichProductsWithComponents(fetchedRows)
    );
  }

  return {
    productsBySku,
    qtyCache: new Map(),
    availabilityCache: new Map()
  };
}

async function buildFullProductGraph() {
  const [products, components] = await Promise.all([queryAllProducts(), queryAllComponents()]);
  const productsWithComponents = await attachWarehouseQtyToProducts(
    attachComponentsToProducts(products, components)
  );

  return {
    rows: productsWithComponents,
    graph: {
      productsBySku: new Map(
        productsWithComponents
          .map(normalizeProductNode)
          .filter(Boolean)
          .map((product) => [product.sku, product])
      ),
      qtyCache: new Map(),
      availabilityCache: new Map()
    }
  };
}

function getProductGraphProductIds(productGraph) {
  return Array.from(productGraph?.productsBySku?.values?.() || [])
    .map((product) => String(product?.id || "").trim())
    .filter(Boolean);
}

function buildProductVendorAvailability(rows) {
  const productIdsWithActiveVendors = new Set();
  const productIdsWithBuiltToOrderVendors = new Set();
  const vendorQuantityByProductId = new Map();

  for (const row of rows) {
    if (!row?.product_id || !isActiveVendor(row)) {
      continue;
    }

    productIdsWithActiveVendors.add(row.product_id);

    if (Boolean(row?.built_to_order)) {
      productIdsWithBuiltToOrderVendors.add(row.product_id);
      continue;
    }

    vendorQuantityByProductId.set(
      row.product_id,
      (vendorQuantityByProductId.get(row.product_id) || 0) +
        Math.max(Number(row.quantity || 0), 0)
    );
  }

  return {
    productIdsWithActiveVendors,
    productIdsWithBuiltToOrderVendors,
    vendorQuantityByProductId
  };
}

async function getProductVendorAvailabilityInfo(productIds) {
  const rows = await queryVendorAvailabilityRows(productIds);
  return buildProductVendorAvailability(rows);
}

function mapProduct(
  row,
  productVendorAvailability,
  followUpsBySku,
  {
    productsBySku = new Map(),
    qtyCache = new Map(),
    availabilityCache = new Map()
  } = {}
) {
  const normalizedRow = normalizeProductNode(row);
  const sku = normalizedRow?.sku || row?.sku || "";
  const product = normalizedRow?.sku
    ? productsBySku.get(normalizedRow.sku) || normalizedRow
    : null;
  const isKit = Boolean(product?.is_kit);
  const hasActiveVendor = productVendorAvailability.productIdsWithActiveVendors.has(row.id);
  const hasBuiltToOrderVendor =
    productVendorAvailability.productIdsWithBuiltToOrderVendors.has(row.id);
  const qtyAvailable = isKit
    ? getEffectiveQtyAvailable(
        sku,
        productsBySku,
        qtyCache,
        new Set(),
        productVendorAvailability
      )
    : Math.max(
        Number(product?.qty_available || 0),
        getVendorQtyAvailable(product || { id: row.id }, productVendorAvailability)
      );
  const availability = isKit
    ? getEffectiveAvailability(
        sku,
        productsBySku,
        productVendorAvailability,
        availabilityCache
      )
    : mapAvailability(qtyAvailable, hasActiveVendor, hasBuiltToOrderVendor);

  return {
    id: row.id,
    sku,
    name: row.name || "",
    qtyAvailable,
    availability,
    followUpDate: followUpsBySku?.get(sku) || "",
    isKit
  };
}

function buildKitChildProducts(product, productGraph, productVendorAvailability) {
  if (!product?.is_kit) {
    return [];
  }

  return product.relatedProduct.map((child) => {
    const childProduct = productGraph.productsBySku.get(child.sku);
    const qtyAvailable = getEffectiveQtyAvailable(
      child.sku,
      productGraph.productsBySku,
      productGraph.qtyCache,
      new Set(),
      productVendorAvailability
    );

    return {
      sku: child.sku,
      name: childProduct?.name || child.name || child.sku,
      qtyRequired: Math.max(Number(child.qty || 0), 1),
      qtyAvailable,
      availability: getEffectiveAvailability(
        child.sku,
        productGraph.productsBySku,
        productVendorAvailability,
        productGraph.availabilityCache
      ),
      isKit: Boolean(childProduct?.is_kit)
    };
  });
}

async function getProductParentKitsForSku(sku) {
  const parentRows = await queryParentKitsByChildSku(sku);

  if (parentRows.length === 0) {
    return [];
  }

  const productGraph = await buildProductGraph(parentRows);
  const [productVendorAvailability, followUpsBySku] = await Promise.all([
    getProductVendorAvailabilityInfo(getProductGraphProductIds(productGraph)),
    followUpsService.getFollowUpsForSkus(
      parentRows.map((product) => product.sku).filter(Boolean)
    )
  ]);

  return parentRows.map((row) => {
    const mappedProduct = mapProduct(
      row,
      productVendorAvailability,
      followUpsBySku,
      productGraph
    );

    return {
      sku: mappedProduct.sku,
      name: mappedProduct.name,
      qtyRequired: Math.max(Number(row?.qty_required || 0), 1),
      qtyAvailable: mappedProduct.qtyAvailable,
      availability: mappedProduct.availability,
      followUpDate: mappedProduct.followUpDate
    };
  });
}

async function ensureCatalogReady() {
  return initializeSchema();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

async function fetchAllPages(fetchPage) {
  const firstPage = await fetchPage(1);
  const totalPages = Math.max(Number(firstPage.totalPages || 1), 1);
  const rows = [...(firstPage.rows || [])];

  if (totalPages > 1) {
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const remainingResults = await mapWithConcurrency(
      remainingPages,
      productFetchConcurrency,
      (page) => fetchPage(page)
    );

    for (const grid of remainingResults) {
      rows.push(...(grid.rows || []));
    }
  }

  return rows;
}

async function fetchProductsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          sort: { sku: ASC }
          filter: { state: { operator: eq, value: [${graphqlString("Active")}] } }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            ${productSelectionFields}
          }
        }
      }
    }
  `);

  return data?.product?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchActiveProductIdsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          sort: { sku: ASC }
          filter: { state: { operator: eq, value: [${graphqlString("Active")}] } }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
          }
        }
      }
    }
  `);

  return data?.product?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchVendorsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      vendor {
        grid(
          sort: { name: ASC }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
            name
            label
            status
          }
        }
      }
    }
  `);

  return data?.vendor?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchVendorProductsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      vendorProduct {
        grid(
          sort: { sku: ASC }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
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

  return data?.vendorProduct?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchWarehouseStockPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      stock {
        stocksGrid(
          filter: {
            type: [${dppWarehouseStockType}]
            location: {
              warehouse_label: { operator: eq, value: [${graphqlString(dppWarehouseLabel)}] }
            }
          }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
            qty
            qty_available
            type
            product {
              id
              sku
            }
            location {
              warehouse {
                id
                label
              }
            }
          }
        }
      }
    }
  `);

  return data?.stock?.stocksGrid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchProductBySkuFromSkuNexus(sku) {
  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          filter: {
            sku: { operator: eq, value: [${graphqlString(sku)}] }
            state: { operator: eq, value: [${graphqlString("Active")}] }
          }
          limit: { size: 1, page: 1 }
        ) {
          rows {
            ${productSelectionFields}
          }
        }
      }
    }
  `);

  return data?.product?.grid?.rows?.[0] || null;
}

async function fetchProductsBySkusFromSkuNexus(skus) {
  const uniqueSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  if (uniqueSkus.length === 0) {
    return [];
  }

  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          filter: {
            sku: { operator: in, value: [${graphqlStringList(uniqueSkus)}] }
            state: { operator: eq, value: [${graphqlString("Active")}] }
          }
          limit: { size: ${uniqueSkus.length}, page: 1 }
        ) {
          rows {
            ${productSelectionFields}
          }
        }
      }
    }
  `);

  return data?.product?.grid?.rows || [];
}

async function fetchProductGraphBySkusFromSkuNexus(skus) {
  const productsBySku = new Map();
  let nextSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  while (nextSkus.length > 0) {
    const missingSkus = nextSkus.filter((sku) => !productsBySku.has(sku));

    if (missingSkus.length === 0) {
      break;
    }

    const rows = await fetchProductsBySkusFromSkuNexus(missingSkus);

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const normalized = normalizeProductRow(row);

      if (normalized.product_id && normalized.sku) {
        productsBySku.set(normalized.sku, normalized);
      }
    }

    nextSkus = getKitChildSkus(Array.from(productsBySku.values()));
  }

  return Array.from(productsBySku.values());
}

async function fetchVendorProductsForSkuFromSkuNexus(sku) {
  const data = await skunexus.query(`
    query V1Queries {
      vendorProduct {
        grid(
          filter: {
            product: { sku: { operator: eq, value: [${graphqlString(sku)}] } }
          }
          limit: { size: ${fullSyncPageSize}, page: 1 }
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

  return data?.vendorProduct?.grid?.rows || [];
}

async function fetchVendorsByIdsFromSkuNexus(vendorIds) {
  const uniqueIds = Array.from(
    new Set((vendorIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const data = await skunexus.query(`
    query V1Queries {
      vendor {
        grid(
          filter: { id: { operator: in, value: [${graphqlStringList(uniqueIds)}] } }
          limit: { size: ${uniqueIds.length}, page: 1 }
        ) {
          rows {
            id
            name
            label
            status
          }
        }
      }
    }
  `);

  return data?.vendor?.grid?.rows || [];
}

async function fetchWarehouseStockForSkuFromSkuNexus(sku) {
  const data = await skunexus.query(`
    query V1Queries {
      stock {
        stocksGrid(
          filter: {
            product: { sku: { operator: eq, value: [${graphqlString(sku)}] } }
            type: [${dppWarehouseStockType}]
            location: {
              warehouse_label: { operator: eq, value: [${graphqlString(dppWarehouseLabel)}] }
            }
          }
          limit: { size: 100, page: 1 }
        ) {
          rows {
            id
            qty
            qty_available
            type
            product {
              id
              sku
            }
            location {
              warehouse {
                id
                label
              }
            }
          }
        }
      }
    }
  `);

  return data?.stock?.stocksGrid?.rows || [];
}

async function upsertProducts(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    dedupeRows(
      rows
        .map(normalizeProductRow)
        .filter((row) => row.product_id && row.sku)
        .map(({ product_id, sku, name, state, qty_available, is_kit }) => ({
          product_id,
          sku,
          name,
          state,
          qty_available,
          is_kit
        })),
      (row) => row.product_id
    ),
    (row) => row.sku
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await deleteProductsDisplacedBySku(normalizedRows);
  await sql.query(
    `
      INSERT INTO catalog_products (
        product_id,
        sku,
        name,
        state,
        qty_available,
        is_kit,
        last_synced_at
      )
      SELECT
        row.product_id,
        row.sku,
        row.name,
        row.state,
        row.qty_available,
        row.is_kit,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        product_id text,
        sku text,
        name text,
        state text,
        qty_available integer,
        is_kit boolean
      )
      ON CONFLICT (product_id) DO UPDATE
      SET sku = EXCLUDED.sku,
          name = EXCLUDED.name,
          state = EXCLUDED.state,
          qty_available = EXCLUDED.qty_available,
          is_kit = EXCLUDED.is_kit,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function deleteProductsDisplacedBySku(rows) {
  const skuRows = rows
    .map((row) => ({
      product_id: String(row?.product_id || "").trim(),
      sku: String(row?.sku || "").trim()
    }))
    .filter((row) => row.product_id && row.sku);

  if (skuRows.length === 0) {
    return;
  }

  const sql = getSql();
  const displacedRows = await sql.query(
    `
      WITH incoming AS (
        SELECT product_id, sku
        FROM jsonb_to_recordset($1::jsonb) AS row(
          product_id text,
          sku text
        )
      )
      SELECT p.product_id
      FROM catalog_products p
      JOIN incoming i
        ON i.sku = p.sku
      WHERE p.product_id <> i.product_id
    `,
    [JSON.stringify(skuRows)]
  );
  const displacedProductIds = Array.from(
    new Set(
      displacedRows
        .map((row) => String(row?.product_id || "").trim())
        .filter(Boolean)
    )
  );

  if (displacedProductIds.length === 0) {
    return;
  }

  const idJson = JSON.stringify(displacedProductIds);

  await sql.query(
    `
      DELETE FROM catalog_product_components
      WHERE parent_product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
  await sql.query(
    `
      DELETE FROM catalog_vendor_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
  await sql.query(
    `
      DELETE FROM catalog_warehouse_stock
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
  await sql.query(
    `
      DELETE FROM catalog_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

async function upsertComponents(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map((row) => ({
        parent_product_id: String(row?.parent_product_id || "").trim(),
        child_sku: String(row?.child_sku || "").trim(),
        child_name: String(row?.child_name || row?.child_sku || "").trim(),
        qty_required: Math.max(Number(row?.qty_required || 0), 1)
      }))
      .filter((row) => row.parent_product_id && row.child_sku),
    (row) => `${row.parent_product_id}:${row.child_sku}`
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_product_components (
        parent_product_id,
        child_sku,
        child_name,
        qty_required,
        last_synced_at
      )
      SELECT
        row.parent_product_id,
        row.child_sku,
        row.child_name,
        row.qty_required,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        parent_product_id text,
        child_sku text,
        child_name text,
        qty_required integer
      )
      ON CONFLICT (parent_product_id, child_sku) DO UPDATE
      SET child_name = EXCLUDED.child_name,
          qty_required = EXCLUDED.qty_required,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function upsertVendors(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map(normalizeVendorRow)
      .filter((row) => row.vendor_id),
    (row) => row.vendor_id
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_vendors (
        vendor_id,
        name,
        label,
        status,
        last_synced_at
      )
      SELECT
        row.vendor_id,
        row.name,
        row.label,
        row.status,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        vendor_id text,
        name text,
        label text,
        status integer
      )
      ON CONFLICT (vendor_id) DO UPDATE
      SET name = EXCLUDED.name,
          label = EXCLUDED.label,
          status = EXCLUDED.status,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function upsertVendorProducts(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map(normalizeVendorProductRow)
      .filter((row) => row.vendor_product_id && row.vendor_id && row.product_id),
    (row) => row.vendor_product_id
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_vendor_products (
        vendor_product_id,
        vendor_id,
        product_id,
        sku,
        label,
        quantity,
        status,
        price,
        last_synced_at
      )
      SELECT
        row.vendor_product_id,
        row.vendor_id,
        row.product_id,
        row.sku,
        row.label,
        row.quantity,
        row.status,
        row.price,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        vendor_product_id text,
        vendor_id text,
        product_id text,
        sku text,
        label text,
        quantity double precision,
        status double precision,
        price double precision
      )
      ON CONFLICT (vendor_product_id) DO UPDATE
      SET vendor_id = EXCLUDED.vendor_id,
          product_id = EXCLUDED.product_id,
          sku = EXCLUDED.sku,
          label = EXCLUDED.label,
          quantity = EXCLUDED.quantity,
          status = EXCLUDED.status,
          price = EXCLUDED.price,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function upsertWarehouseStock(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map((row) => ({
        product_id: String(row?.product_id || "").trim(),
        stock_id: String(row?.stock_id || "").trim(),
        warehouse_label: String(row?.warehouse_label || dppWarehouseLabel).trim(),
        stock_type: String(row?.stock_type || dppWarehouseStockType).trim(),
        qty: Number(row?.qty || 0),
        qty_available: Number(row?.qty_available || 0)
      }))
      .filter((row) => row.product_id),
    (row) => row.product_id
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_warehouse_stock (
        product_id,
        stock_id,
        warehouse_label,
        stock_type,
        qty,
        qty_available,
        last_synced_at
      )
      SELECT
        row.product_id,
        row.stock_id,
        row.warehouse_label,
        row.stock_type,
        row.qty,
        row.qty_available,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        product_id text,
        stock_id text,
        warehouse_label text,
        stock_type text,
        qty double precision,
        qty_available double precision
      )
      ON CONFLICT (product_id) DO UPDATE
      SET stock_id = EXCLUDED.stock_id,
          warehouse_label = EXCLUDED.warehouse_label,
          stock_type = EXCLUDED.stock_type,
          qty = EXCLUDED.qty,
          qty_available = EXCLUDED.qty_available,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function deleteStaleFullSyncRows(syncStamp, { includeWarehouse = true } = {}) {
  const sql = getSql();

  await sql.query(
    `DELETE FROM catalog_products WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  await sql.query(
    `DELETE FROM catalog_product_components WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  await sql.query(
    `DELETE FROM catalog_vendors WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  await sql.query(
    `DELETE FROM catalog_vendor_products WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  if (includeWarehouse) {
    await sql.query(
      `DELETE FROM catalog_warehouse_stock WHERE last_synced_at < $1::timestamptz`,
      [syncStamp]
    );
  }
}

async function deleteStaleWarehouseRows(syncStamp) {
  const sql = getSql();
  await sql.query(
    `DELETE FROM catalog_warehouse_stock WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
}

async function markProductsInactiveByIds(productIds, syncStamp) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return 0;
  }

  const sql = getSql();
  const rows = await sql.query(
    `
      UPDATE catalog_products
      SET state = 'Inactive',
          qty_available = 0,
          last_synced_at = $2::timestamptz
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      AND lower(COALESCE(state, 'Active')) = 'active'
      RETURNING product_id
    `,
    [JSON.stringify(uniqueIds), syncStamp]
  );

  if (rows.length > 0) {
    await sql.query(
      `
        DELETE FROM catalog_warehouse_stock
        WHERE product_id IN (
          SELECT jsonb_array_elements_text($1::jsonb)
        )
      `,
      [JSON.stringify(rows.map((row) => row.product_id).filter(Boolean))]
    );
  }

  return rows.length;
}

async function markProductInactiveBySku(sku, syncStamp) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return 0;
  }

  const sql = getSql();
  const rows = await sql`
    UPDATE catalog_products
    SET state = 'Inactive',
        qty_available = 0,
        last_synced_at = ${syncStamp}
    WHERE sku = ${safeSku}
    AND lower(COALESCE(state, 'Active')) = 'active'
    RETURNING product_id
  `;

  if (rows.length > 0) {
    await sql.query(
      `
        DELETE FROM catalog_warehouse_stock
        WHERE product_id IN (
          SELECT jsonb_array_elements_text($1::jsonb)
        )
      `,
      [JSON.stringify(rows.map((row) => row.product_id).filter(Boolean))]
    );
  }

  return rows.length;
}

async function syncInactiveProductStates(syncStamp) {
  const rows = await fetchAllPages(fetchActiveProductIdsPageFromSkuNexus);
  const activeProductIds = new Set(
    rows.map((row) => String(row?.id || "").trim()).filter(Boolean)
  );

  if (activeProductIds.size === 0) {
    throw new Error("SKU Nexus active product state sync returned no products.");
  }

  const sql = getSql();
  const cachedRows = await sql`
    SELECT product_id
    FROM catalog_products
    WHERE lower(COALESCE(state, 'Active')) = 'active'
  `;
  const inactiveProductIds = cachedRows
    .map((row) => String(row?.product_id || "").trim())
    .filter((productId) => productId && !activeProductIds.has(productId));
  const markedInactive = await markProductsInactiveByIds(
    inactiveProductIds,
    syncStamp
  );

  if (markedInactive > 0) {
    clearCaches();
  }

  return {
    activeProducts: activeProductIds.size,
    deactivatedProducts: markedInactive
  };
}

async function runFullSync({ reason = "manual" } = {}) {
  await initializeSchema();

  if (fullSyncPromise) {
    return fullSyncPromise;
  }

  fullSyncPromise = (async () => {
    const syncStamp = new Date().toISOString();
    const warehouseRowsResult = fetchAllPages(fetchWarehouseStockPageFromSkuNexus)
      .then((rows) => ({ rows, error: null }))
      .catch((error) => ({ rows: [], error }));
    const [products, vendors, vendorProducts, rawWarehouseRowsResult] =
      await Promise.all([
        fetchAllPages(fetchProductsPageFromSkuNexus),
        fetchAllPages(fetchVendorsPageFromSkuNexus),
        fetchAllPages(fetchVendorProductsPageFromSkuNexus),
        warehouseRowsResult
      ]);
    let warehouseStockRows = [];
    const didSyncWarehouse = !rawWarehouseRowsResult.error;

    if (rawWarehouseRowsResult.error) {
      console.error(
        "Warehouse stock sync failed; continuing without warehouse cache.",
        rawWarehouseRowsResult.error
      );
    } else {
      warehouseStockRows = aggregateWarehouseStockRows(rawWarehouseRowsResult.rows);
    }

    const normalizedProducts = products
      .map(normalizeProductRow)
      .filter((row) => row.product_id && row.sku);
    const componentRows = flattenProductComponents(normalizedProducts);

    await upsertProducts(normalizedProducts, syncStamp);
    await upsertComponents(componentRows, syncStamp);
    await upsertVendors(vendors, syncStamp);
    await upsertVendorProducts(vendorProducts, syncStamp);
    if (didSyncWarehouse) {
      await upsertWarehouseStock(warehouseStockRows, syncStamp);
    }
    await deleteStaleFullSyncRows(syncStamp, { includeWarehouse: didSyncWarehouse });
    await setSyncState("catalog_last_full_sync_at", syncStamp);
    await setSyncState("catalog_last_full_sync_reason", reason);
    if (didSyncWarehouse) {
      await setSyncState("catalog_last_warehouse_sync_at", syncStamp);
      await setSyncState("catalog_last_warehouse_sync_reason", reason);
    }
    clearCaches();

    return {
      syncedAt: syncStamp,
      products: normalizedProducts.length,
      vendors: vendors.length,
      vendorProducts: vendorProducts.length,
      warehouseProducts: warehouseStockRows.length
    };
  })();

  try {
    return await fullSyncPromise;
  } finally {
    fullSyncPromise = null;
  }
}

async function runWarehouseSync({ reason = "manual" } = {}) {
  await initializeSchema();

  if (fullSyncPromise) {
    return fullSyncPromise;
  }

  if (warehouseSyncPromise) {
    return warehouseSyncPromise;
  }

  warehouseSyncPromise = (async () => {
    const syncStamp = new Date().toISOString();
    const rawWarehouseRows = await fetchAllPages(fetchWarehouseStockPageFromSkuNexus);
    const warehouseStockRows = aggregateWarehouseStockRows(rawWarehouseRows);
    let productStateResult = {
      activeProducts: 0,
      deactivatedProducts: 0
    };

    await upsertWarehouseStock(warehouseStockRows, syncStamp);
    await deleteStaleWarehouseRows(syncStamp);
    try {
      productStateResult = await syncInactiveProductStates(syncStamp);
      await setSyncState("catalog_last_product_state_sync_at", syncStamp);
      await setSyncState("catalog_last_product_state_sync_reason", reason);
    } catch (error) {
      console.error("Product active-state sync failed; continuing warehouse sync.", error);
    }
    await setSyncState("catalog_last_warehouse_sync_at", syncStamp);
    await setSyncState("catalog_last_warehouse_sync_reason", reason);
    clearCaches();

    return {
      syncedAt: syncStamp,
      warehouseProducts: warehouseStockRows.length,
      activeProducts: productStateResult.activeProducts,
      deactivatedProducts: productStateResult.deactivatedProducts
    };
  })();

  try {
    return await warehouseSyncPromise;
  } finally {
    warehouseSyncPromise = null;
  }
}

async function refreshProductBySku(sku, options = {}) {
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const includeWarehouse = options.includeWarehouse !== false;

  if (fullSyncPromise) {
    await fullSyncPromise;
  }

  const refreshKey = `${safeSku}:${includeWarehouse ? "warehouse" : "product"}`;

  if (productRefreshPromises.has(refreshKey)) {
    return productRefreshPromises.get(refreshKey);
  }

  const refreshPromise = (async () => {
    await initializeSchema();
    const syncStamp = new Date().toISOString();
    const rootProduct = await fetchProductBySkuFromSkuNexus(safeSku);

    if (!rootProduct) {
      await markProductInactiveBySku(safeSku, syncStamp);
      clearCaches();
      const error = new Error("Product not found.");
      error.statusCode = 404;
      throw error;
    }

    const productGraphRows = await fetchProductGraphBySkusFromSkuNexus([safeSku]);
    const normalizedProducts = productGraphRows
      .map(normalizeProductRow)
      .filter((row) => row.product_id && row.sku);
    const componentRows = flattenProductComponents(normalizedProducts);
    const vendorProducts = await fetchVendorProductsForSkuFromSkuNexus(safeSku);
    const vendorIds = Array.from(
      new Set(vendorProducts.map((row) => row.vendor_id).filter(Boolean))
    );
    const vendors = await fetchVendorsByIdsFromSkuNexus(vendorIds);
    let warehouseStockRows = [];
    let didRefreshWarehouse = false;

    if (includeWarehouse) {
      try {
        warehouseStockRows = aggregateWarehouseStockRows(
          await fetchWarehouseStockForSkuFromSkuNexus(safeSku)
        );
        didRefreshWarehouse = true;
      } catch (error) {
        console.error("Product warehouse refresh failed.", error);
      }
    }

    await upsertProducts(normalizedProducts, syncStamp);
    await upsertComponents(componentRows, syncStamp);
    await upsertVendors(vendors, syncStamp);
    await upsertVendorProducts(vendorProducts, syncStamp);
    if (didRefreshWarehouse) {
      await upsertWarehouseStock(warehouseStockRows, syncStamp);
    }

    const sql = getSql();
    const parentProductIds = Array.from(
      new Set(normalizedProducts.map((row) => row.product_id).filter(Boolean))
    );
    const vendorProductProductId =
      normalizedProducts.find((row) => row.sku === safeSku)?.product_id ||
      String(rootProduct?.id || "").trim();

    if (parentProductIds.length > 0) {
      await sql.query(
        `
          DELETE FROM catalog_product_components
          WHERE parent_product_id IN (
            SELECT jsonb_array_elements_text($1::jsonb)
          )
          AND last_synced_at < $2::timestamptz
        `,
        [JSON.stringify(parentProductIds), syncStamp]
      );
    }

    if (vendorProductProductId) {
      await sql.query(
        `
          DELETE FROM catalog_vendor_products
          WHERE product_id = $1
          AND last_synced_at < $2::timestamptz
        `,
        [vendorProductProductId, syncStamp]
      );
      if (didRefreshWarehouse && warehouseStockRows.length === 0) {
        await sql.query(`DELETE FROM catalog_warehouse_stock WHERE product_id = $1`, [
          vendorProductProductId
        ]);
      }
    }

    clearCaches();

    return {
      syncedAt: syncStamp,
      products: normalizedProducts.length,
      vendorProducts: vendorProducts.length
    };
  })();

  productRefreshPromises.set(refreshKey, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    productRefreshPromises.delete(refreshKey);
  }
}

async function listProducts(queryParams = {}) {
  await ensureCatalogReady();
  const { page, limit } = normalizePaging(queryParams);
  const search = normalizeSearch(queryParams.search);

  if (!search) {
    return emptyProductsResponse();
  }

  const result = await queryProductsPage({ page, limit, search });
  const rows = result.data || [];
  const [productGraph, followUpsBySku] = await Promise.all([
    buildProductGraph(rows),
    followUpsService.getFollowUpsForSkus(rows.map((product) => product.sku).filter(Boolean))
  ]);
  const productVendorAvailability = await getProductVendorAvailabilityInfo(
    getProductGraphProductIds(productGraph)
  );

  return {
    ...result,
    data: rows.map((product) =>
      mapProduct(product, productVendorAvailability, followUpsBySku, productGraph)
    )
  };
}

async function getProductDetails(sku) {
  await ensureCatalogReady();
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const product = await queryProductBySku(safeSku);

  if (!product) {
    const error = new Error("Product not found.");
    error.statusCode = 404;
    throw error;
  }

  const [
    productGraph,
    vendorProducts,
    warehouseStock,
    followUpInfo,
    shopifyAvailabilityStatus,
    parentKits
  ] = await Promise.all([
    buildProductGraph([product]),
    queryVendorProductsByProductId(product.id),
    queryWarehouseStockByProductId(product.id),
    followUpsService.getFollowUpInfoForSku(safeSku),
    shopifyAvailabilityStateService.getAvailabilityStatusForSku(safeSku),
    getProductParentKitsForSku(safeSku)
  ]);
  const productNode =
    productGraph.productsBySku.get(product.sku || safeSku) || normalizeProductNode(product);
  const productVendorAvailability = await getProductVendorAvailabilityInfo(
    getProductGraphProductIds(productGraph)
  );
  const qtyAvailable = productNode
    ? getEffectiveQtyAvailable(
        productNode.sku,
        productGraph.productsBySku,
        productGraph.qtyCache,
        new Set(),
        productVendorAvailability
      )
    : 0;
  const availability = productNode
    ? getEffectiveAvailability(
        productNode.sku,
        productGraph.productsBySku,
        productVendorAvailability,
        productGraph.availabilityCache
      )
    : "Backorder";
  const childProducts = buildKitChildProducts(
    productNode,
    productGraph,
    productVendorAvailability
  );
  const vendorIds = Array.from(
    new Set(vendorProducts.map((row) => row.vendor_id).filter(Boolean))
  );
  const [vendors, settingsByVendorId] = await Promise.all([
    queryVendorsByIds(vendorIds),
    vendorSettingsService.getVendorSettingsByVendorIds(vendorIds)
  ]);
  const vendorsById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const assignedVendors = vendorProducts
    .filter((vendorProduct) => vendorProduct.id && vendorProduct.vendor_id)
    .map((vendorProduct) => {
      const vendor = vendorsById.get(vendorProduct.vendor_id);
      const settings = settingsByVendorId.get(vendorProduct.vendor_id);

      return {
        id: vendorProduct.vendor_id,
        vendorProductId: vendorProduct.id,
        name: vendor?.name || vendor?.label || vendorProduct.vendor_id,
        quantity: Number(vendorProduct.quantity || 0),
        stockSource: "vendor",
        stockType: "VENDOR",
        canUpdateStock: !settings?.builtToOrder,
        builtToOrder: Boolean(settings?.builtToOrder),
        buildTime: String(settings?.buildTime || "")
      };
    });
  const assignedStockSources = [
    ...assignedVendors,
    ...(warehouseStock
      ? [
          {
            id: warehouseStock.stock_id || dppWarehouseLabel,
            vendorProductId: `warehouse:${warehouseStock.stock_id || dppWarehouseLabel}`,
            name: warehouseStock.warehouse_label || dppWarehouseLabel,
            quantity: Number(warehouseStock.qty_available || 0),
            stockSource: "warehouse",
            stockType: warehouseStock.stock_type || dppWarehouseStockType,
            canUpdateStock: false,
            builtToOrder: false,
            buildTime: ""
          }
        ]
      : [])
  ].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );

  return {
    id: product.id,
    sku: product.sku || safeSku,
    name: product.name || product.sku || safeSku,
    qtyAvailable,
    availability,
    isKit: Boolean(productNode?.is_kit),
    followUpDate: followUpInfo.followUpDate,
    followUpNoEta: followUpInfo.followUpNoEta,
    shopifyAvailabilityStatus,
    childProducts,
    parentKits,
    vendors: assignedStockSources
  };
}

async function getStockCheckProducts({
  search,
  sort = "all",
  referenceDate = "",
  bypassCache = false
} = {}) {
  await ensureCatalogReady();
  const cleanSearch = normalizeSearch(search);
  const cleanSort = normalizeStockCheckSort(sort);
  const cleanReferenceDate = normalizeDateText(referenceDate);
  const cacheKey = `${cleanSearch.toLowerCase()}:${cleanSort}:${cleanReferenceDate}`;
  const cached = stockCheckCache.get(cacheKey);
  const shouldBypassCache = normalizeBoolean(bypassCache);

  if (!shouldBypassCache && cached && Date.now() - cached.createdAt < stockCheckCacheTtlMs) {
    return cached.data;
  }

  const [{ rows, graph }, followUpsBySku, productVendorAvailability] = await Promise.all([
    buildFullProductGraph(),
    followUpsService.getAllFollowUps(),
    getProductVendorAvailabilityInfo()
  ]);

  const data = rows
    .map((product) =>
      mapProduct(product, productVendorAvailability, followUpsBySku, graph)
    )
    .filter((product) => !product.isKit)
    .filter((product) => product.availability !== "Built to Order")
    .filter(
      (product) =>
        product.availability !== "Available" || Boolean(product.followUpDate)
    )
    .filter((product) => matchesProductSearch(product, cleanSearch));
  const filteredData = filterStockCheckProducts(
    data,
    cleanSort,
    cleanReferenceDate
  );

  stockCheckCache.set(cacheKey, {
    createdAt: Date.now(),
    data: filteredData
  });

  return filteredData;
}

async function listStockCheckProducts(queryParams = {}) {
  const { page, limit } = normalizePaging(queryParams);
  const products = await getStockCheckProducts({
    search: queryParams.search,
    sort: queryParams.sort,
    referenceDate: queryParams.referenceDate,
    bypassCache: queryParams.bypassCache
  });
  const pageResult = paginateRows(products, { page, limit });
  const emailedSkus = await stockCheckEmailsService.getEmailedSkuSetForSkus(
    pageResult.data.map((product) => product.sku)
  );

  return {
    ...pageResult,
    data: pageResult.data.map((product) => ({
      ...product,
      vendorEmailSent: emailedSkus.has(String(product.sku || "").trim().toUpperCase())
    }))
  };
}

function mapVendorSummary(row) {
  return {
    id: String(row?.vendor_id || "").trim(),
    vendor: String(row?.name || row?.label || row?.vendor_id || "").trim()
  };
}

async function listVendors(queryParams = {}) {
  await ensureCatalogReady();
  const { page, limit } = normalizePaging(queryParams);
  const search = normalizeSearch(queryParams.search).toLowerCase();
  const rows = await queryAllVendors();
  const filtered = rows
    .map(mapVendorSummary)
    .filter((vendor) => vendor.id && vendor.vendor)
    .filter((vendor) =>
      !search ? true : vendor.vendor.toLowerCase().includes(search)
    );

  return paginateRows(filtered, { page, limit });
}

async function getVendorDetails(vendorId) {
  await ensureCatalogReady();
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const [vendor, settings] = await Promise.all([
    queryVendorById(safeVendorId),
    vendorSettingsService.getVendorSettings(safeVendorId)
  ]);

  if (!vendor) {
    const error = new Error("Vendor not found.");
    error.statusCode = 404;
    throw error;
  }

  return {
    id: safeVendorId,
    vendor: vendor.name || vendor.label || safeVendorId,
    builtToOrder: Boolean(settings?.builtToOrder),
    buildTime: String(settings?.buildTime || "")
  };
}

async function listVendorProducts(vendorId, queryParams = {}) {
  await ensureCatalogReady();
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const { page, limit } = normalizePaging(queryParams);
  const search = normalizeSearch(queryParams.search);
  const [vendor, pageResult] = await Promise.all([
    getVendorDetails(safeVendorId),
    queryVendorProductsPage({
      vendorId: safeVendorId,
      page,
      limit,
      search
    })
  ]);
  const productIds = pageResult.data.map((row) => row.product_id).filter(Boolean);
  const builtToOrderProductIds = (
    await getProductVendorAvailabilityInfo(productIds)
  ).productIdsWithBuiltToOrderVendors;

  return {
    ...pageResult,
    vendor,
    data: pageResult.data.map((row) => {
      const qtyAvailable = Number(row.qty_available || 0);

      return {
        id: row.product_id || row.vendor_product_id,
        vendorProductId: row.vendor_product_id,
        sku: row.product_sku || row.sku || row.label || "",
        name: row.product_name || "",
        qtyAvailable,
        availability: mapAvailability(
          qtyAvailable,
          true,
          builtToOrderProductIds.has(row.product_id)
        )
      };
    })
  };
}

async function runScheduledFullSync() {
  const { localDate, localHour } = getTimeZoneDateParts(new Date(), syncTimezone);
  const localHourKey = `${localDate}-${String(localHour).padStart(2, "0")}`;
  const lastLocalDate = await getSyncState("catalog_last_full_sync_local_date");

  if (lastLocalDate === localDate) {
    return {
      ok: true,
      skipped: true,
      mode: "full",
      reason: `Full sync already ran for ${localDate} in ${syncTimezone}.`,
      localDate,
      localHour
    };
  }

  try {
    const result = await runFullSync({ reason: "scheduled-full-sync" });
    await setSyncState("catalog_last_full_sync_local_date", localDate);
    await setSyncState("catalog_last_warehouse_sync_local_hour", localHourKey);
    await setSyncState("catalog_last_full_sync_error_at", "");
    await setSyncState("catalog_last_full_sync_error", "");

    return {
      ok: true,
      skipped: false,
      mode: "full",
      localDate,
      localHour,
      ...result
    };
  } catch (error) {
    const errorMessage = String(error?.message || error || "Full sync failed.").slice(
      0,
      1000
    );
    await setSyncState("catalog_last_full_sync_error_at", new Date().toISOString());
    await setSyncState("catalog_last_full_sync_error", errorMessage);
    throw error;
  }
}

async function runScheduledWarehouseSync() {
  const { localDate, localHour } = getTimeZoneDateParts(new Date(), syncTimezone);
  const localHourKey = `${localDate}-${String(localHour).padStart(2, "0")}`;

  if (!isWarehouseSyncWindow(localHour)) {
    return {
      ok: true,
      skipped: true,
      mode: "warehouse",
      reason: `Warehouse sync is paused from 8pm to 6am in ${syncTimezone}.`,
      localDate,
      localHour
    };
  }

  const lastWarehouseLocalHour = await getSyncState(
    "catalog_last_warehouse_sync_local_hour"
  );

  if (lastWarehouseLocalHour === localHourKey) {
    return {
      ok: true,
      skipped: true,
      mode: "warehouse",
      reason: `Warehouse sync already ran for ${localHourKey} in ${syncTimezone}.`,
      localDate,
      localHour
    };
  }

  const result = await runWarehouseSync({ reason: "scheduled-warehouse-sync" });
  await setSyncState("catalog_last_warehouse_sync_local_hour", localHourKey);

  return {
    ok: true,
    skipped: false,
    mode: "warehouse",
    localDate,
    localHour,
    ...result
  };
}

async function getCatalogSyncStatus() {
  await initializeSchema();
  const sql = getSql();
  const stateRows = await sql`
    SELECT sync_key, sync_value, updated_at
    FROM catalog_sync_state
    ORDER BY sync_key ASC
  `;
  const countRows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM catalog_products) AS products,
      (SELECT COUNT(*)::int FROM catalog_vendors) AS vendors,
      (SELECT COUNT(*)::int FROM catalog_vendor_products) AS vendor_products,
      (SELECT COUNT(*)::int FROM catalog_warehouse_stock) AS warehouse_products,
      (SELECT MAX(last_synced_at) FROM catalog_products) AS products_last_synced_at,
      (SELECT MAX(last_synced_at) FROM catalog_vendors) AS vendors_last_synced_at,
      (SELECT MAX(last_synced_at) FROM catalog_vendor_products) AS vendor_products_last_synced_at,
      (SELECT MAX(last_synced_at) FROM catalog_warehouse_stock) AS warehouse_last_synced_at
  `;
  const syncState = stateRows.reduce((state, row) => {
    state[row.sync_key] = {
      value: row.sync_value,
      updatedAt: row.updated_at
    };

    return state;
  }, {});

  return {
    timezone: syncTimezone,
    syncState,
    counts: countRows[0] || {}
  };
}

async function runScheduledCatalogSync() {
  return runScheduledWarehouseSync();
}

function clearCaches() {
  stockCheckCache.clear();
}

module.exports = {
  clearCaches,
  getCatalogProductBySku: queryProductBySku,
  getActiveCatalogVendorProductsByVendorId: queryActiveVendorProductsByVendorId,
  getCatalogVendorProductByVendorAndSku: queryVendorProductByVendorAndSku,
  getCatalogVendorProductById: queryVendorProductById,
  getCatalogSyncStatus,
  getProductDetails,
  getVendorDetails,
  listProducts,
  listStockCheckProducts,
  listVendorProducts,
  listVendors,
  refreshProductBySku,
  runScheduledCatalogSync,
  runScheduledFullSync,
  runScheduledWarehouseSync,
  runFullSync,
  runWarehouseSync,
  updateCatalogVendorProductQuantity
};
