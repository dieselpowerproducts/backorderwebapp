const crypto = require("crypto");
const { Readable } = require("stream");
const csv = require("csv-parser");
const ExcelJS = require("exceljs");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const catalogService = require("./catalog.service");
const notificationsService = require("./notifications.service");
const productsService = require("./products.service");
const settingsService = require("./vendorAutoInventorySettings.service");
const importsService = require("./vendorAutoInventoryImports.service");
const { loadLocalEnv } = require("../config/env");

loadLocalEnv();

const enabledVendorStockQuantity = 999999;
const disabledVendorStockQuantity = 0;
const defaultLookbackDays = 14;
const autoInventoryFailureRecipient =
  process.env.AUTO_INVENTORY_FAILURE_RECIPIENT || "cade@dieselpowerproducts.com";
const vendorInventoryLabel =
  process.env.AUTO_INVENTORY_GMAIL_LABEL || "Vendor Inventory";
const gmailInboxLabels = ["\\Inbox", "INBOX"];

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeSkuKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getSkuMatchKeys(value) {
  const safeValue = normalizeText(value).toLowerCase();
  const keys = new Set();
  const addKey = (keyValue) => {
    const key = normalizeSkuKey(keyValue);

    if (key) {
      keys.add(key);
    }
  };

  addKey(safeValue);

  const parts = safeValue.split(/[-_\s]+/).filter(Boolean);

  if (parts.length > 1) {
    addKey(parts.slice(1).join("-"));
  }

  return Array.from(keys);
}

function addSkuMatchKeys(keySet, value) {
  for (const key of getSkuMatchKeys(value)) {
    keySet.add(key);
  }
}

function getVendorProductSkuValues(vendorProduct) {
  return [
    vendorProduct?.product_sku,
    vendorProduct?.sku,
    vendorProduct?.label
  ].filter(Boolean);
}

function getVendorProductDisplaySku(vendorProduct) {
  return (
    normalizeText(vendorProduct?.product_sku) ||
    normalizeText(vendorProduct?.sku) ||
    normalizeText(vendorProduct?.label) ||
    normalizeText(vendorProduct?.id)
  );
}

function buildVendorProductSkuLookup(vendorProducts) {
  const lookup = new Map();

  for (const vendorProduct of vendorProducts) {
    for (const value of getVendorProductSkuValues(vendorProduct)) {
      for (const key of getSkuMatchKeys(value)) {
        const current = lookup.get(key) || [];

        if (!current.some((item) => item.id === vendorProduct.id)) {
          current.push(vendorProduct);
        }

        lookup.set(key, current);
      }
    }
  }

  return lookup;
}

function findVendorProductForSheetSku(lookup, sku) {
  const keys = getSkuMatchKeys(sku);
  const exactKey = normalizeSkuKey(sku);

  for (const key of keys) {
    const candidates = lookup.get(key) || [];

    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      const exactCandidates = candidates.filter((candidate) =>
        getVendorProductSkuValues(candidate).some(
          (value) => normalizeSkuKey(value) === exactKey
        )
      );

      if (exactCandidates.length === 1) {
        return exactCandidates[0];
      }
    }
  }

  return null;
}

function isVendorProductRepresentedInSheet(vendorProduct, sheetSkuKeys) {
  return getVendorProductSkuValues(vendorProduct).some((value) =>
    getSkuMatchKeys(value).some((key) => sheetSkuKeys.has(key))
  );
}

function buildSkuExceptionKeys(skuExceptions) {
  const keys = new Set();

  for (const sku of skuExceptions || []) {
    addSkuMatchKeys(keys, sku);
  }

  return keys;
}

function isVendorProductExcepted(vendorProduct, exceptionKeys) {
  if (!exceptionKeys || exceptionKeys.size === 0) {
    return false;
  }

  return getVendorProductSkuValues(vendorProduct).some((value) =>
    getSkuMatchKeys(value).some((key) => exceptionKeys.has(key))
  );
}

function formatMissingVendorProducts(vendorProducts) {
  const sample = vendorProducts
    .slice(0, 25)
    .map(getVendorProductDisplaySku)
    .filter(Boolean);
  const remainder = vendorProducts.length - sample.length;

  return [
    `StockBridge vendor products missing from inventory sheet (${vendorProducts.length}):`,
    sample.join(", "),
    remainder > 0 ? `and ${remainder} more.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function getBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function getImapConfig() {
  const user = normalizeText(process.env.GMAIL_IMAP_USER) || normalizeText(process.env.GMAIL_USER);
  const pass =
    normalizeText(process.env.GMAIL_IMAP_APP_PASSWORD) ||
    normalizeText(process.env.GMAIL_APP_PASSWORD);
  const missing = [
    ["GMAIL_IMAP_USER or GMAIL_USER", user],
    ["GMAIL_IMAP_APP_PASSWORD or GMAIL_APP_PASSWORD", pass]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    const error = new Error(`Missing Gmail IMAP configuration: ${missing.join(", ")}`);
    error.statusCode = 503;
    throw error;
  }

  const port = Number.parseInt(process.env.GMAIL_IMAP_PORT || "993", 10);

  return {
    host: normalizeText(process.env.GMAIL_IMAP_HOST) || "imap.gmail.com",
    port: Number.isFinite(port) ? port : 993,
    secure: getBooleanEnv(process.env.GMAIL_IMAP_SECURE, true),
    auth: {
      user,
      pass
    },
    logger: false
  };
}

function getLookbackDate() {
  const days = Math.max(
    Number.parseInt(process.env.AUTO_INVENTORY_LOOKBACK_DAYS || "", 10) ||
      defaultLookbackDays,
    1
  );
  const date = new Date();

  date.setDate(date.getDate() - days);
  return date;
}

function getAttachmentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function buildFailureNoteId({ vendorId, attachmentHash, reason }) {
  const hash = crypto
    .createHash("sha1")
    .update(`${vendorId}:${attachmentHash}:${reason}`)
    .digest("hex");

  return `auto-inventory:${hash}`;
}

async function notifyAutoInventoryFailure({
  settings,
  attachment,
  attachmentHash,
  reason,
  details = ""
}) {
  const vendorId = normalizeText(settings?.vendorId);
  const filename = normalizeText(attachment?.filename) || "sheet attachment";
  const senderEmail = normalizeEmail(settings?.senderEmail);
  const safeReason = normalizeText(reason);
  const safeDetails = normalizeText(details);
  const notePreview = [
    `Auto inventory import issue for vendor ${vendorId || "unknown vendor"}.`,
    `File: ${filename}.`,
    senderEmail ? `Sender: ${senderEmail}.` : "",
    safeReason ? `Issue: ${safeReason}.` : "",
    safeDetails ? `Details: ${safeDetails}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  await notificationsService.createSystemNotification({
    recipientEmail: autoInventoryFailureRecipient,
    recipientName: "Cade Carlson",
    sku: "AUTO-INVENTORY",
    noteId: buildFailureNoteId({
      vendorId,
      attachmentHash: attachmentHash || filename,
      reason: safeReason || "unknown"
    }),
    notePreview,
    senderName: "StockBridge Auto Inventory"
  });
}

function getAttachmentExtension(attachment) {
  const filename = normalizeText(attachment?.filename).toLowerCase();

  return filename.includes(".") ? filename.split(".").pop() : "";
}

function isCsvAttachment(attachment) {
  const extension = getAttachmentExtension(attachment);
  const contentType = normalizeText(attachment?.contentType).toLowerCase();

  return (
    extension === "csv" ||
    contentType.includes("csv")
  );
}

function isExcelAttachment(attachment) {
  const extension = getAttachmentExtension(attachment);
  const contentType = normalizeText(attachment?.contentType).toLowerCase();

  return (
    ["xlsx", "xlsm", "xltx", "xltm"].includes(extension) ||
    contentType.includes("spreadsheetml") ||
    contentType.includes("officedocument.spreadsheetml")
  );
}

function isInventorySheetAttachment(attachment) {
  const extension = getAttachmentExtension(attachment);
  const contentType = normalizeText(attachment?.contentType).toLowerCase();

  return (
    isCsvAttachment(attachment) ||
    isExcelAttachment(attachment) ||
    ["xls", "ods"].includes(extension) ||
    contentType.includes("excel")
  );
}

function getSenderEmails(parsedMessage) {
  return (parsedMessage?.from?.value || [])
    .map((sender) => normalizeEmail(sender?.address))
    .filter(Boolean);
}

function getMessageDateValue(message) {
  const date = new Date(message?.internalDate || 0);

  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getLatestMessage(messages) {
  return messages.reduce((latest, message) => {
    if (!latest) {
      return message;
    }

    const messageDate = getMessageDateValue(message);
    const latestDate = getMessageDateValue(latest);

    if (messageDate > latestDate) {
      return message;
    }

    if (messageDate === latestDate && Number(message?.uid || 0) > Number(latest?.uid || 0)) {
      return message;
    }

    return latest;
  }, null);
}

function findHeaderValue(row, headerName) {
  const wantedHeader = normalizeComparable(headerName);
  const key = Object.keys(row || {}).find(
    (item) => normalizeComparable(item.replace(/^\uFEFF/, "")) === wantedHeader
  );

  return key ? normalizeText(row[key]) : "";
}

function hasHeader(row, headerName) {
  const wantedHeader = normalizeComparable(headerName);

  return Object.keys(row || {}).some(
    (item) => normalizeComparable(item.replace(/^\uFEFF/, "")) === wantedHeader
  );
}

function parseNumericalCount(value, { blankAsZero = false } = {}) {
  const normalized = normalizeText(value).replace(/,/g, "");

  if (!normalized && blankAsZero) {
    return 0;
  }

  const match = normalized.match(/-?\d+(\.\d+)?/);

  if (!match) {
    return null;
  }

  return Number(match[0]);
}

function parseNumericalQuantity(value, subtractiveValue = "", hasSubtractiveColumn = false) {
  const inventoryCount = parseNumericalCount(value);

  if (inventoryCount === null) {
    return null;
  }

  const subtractiveCount = hasSubtractiveColumn
    ? parseNumericalCount(subtractiveValue, { blankAsZero: true })
    : 0;

  if (subtractiveCount === null) {
    return null;
  }

  return inventoryCount - subtractiveCount > 0
    ? enabledVendorStockQuantity
    : disabledVendorStockQuantity;
}

function phraseMatches(value, phrases) {
  const normalizedValue = normalizeComparable(value);

  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeComparable(phrase);

    return (
      normalizedPhrase &&
      (normalizedValue === normalizedPhrase ||
        normalizedValue.includes(normalizedPhrase))
    );
  });
}

function parseAlphabeticalQuantity(value, settings) {
  if (phraseMatches(value, settings.inStockPhrases)) {
    return enabledVendorStockQuantity;
  }

  if (phraseMatches(value, settings.outOfStockPhrases)) {
    return disabledVendorStockQuantity;
  }

  return null;
}

function parseInventoryQuantity(value, settings, subtractiveValue = "") {
  const hasSubtractiveColumn = Boolean(
    settings.inventoryMode !== "alphabetical" && settings.subtractiveColumn
  );

  return settings.inventoryMode === "alphabetical"
    ? parseAlphabeticalQuantity(value, settings)
    : parseNumericalQuantity(value, subtractiveValue, hasSubtractiveColumn);
}

function parseCsvRows(content) {
  return new Promise((resolve, reject) => {
    const rows = [];

    Readable.from([content])
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("error", reject)
      .on("end", () => resolve(rows));
  });
}

function getExcelCellText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((item) => item?.text || "")
        .join("")
        .trim();
    }

    if (value.result !== undefined) {
      return getExcelCellText(value.result);
    }

    if (value.text !== undefined) {
      return getExcelCellText(value.text);
    }

    if (value.hyperlink && value.text) {
      return getExcelCellText(value.text);
    }
  }

  return normalizeText(value);
}

function getExcelRowValues(row) {
  const values = [];

  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    values[columnNumber - 1] = getExcelCellText(cell.value);
  });

  return values.map((value) => normalizeText(value));
}

async function parseExcelRows(content) {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(content);

  const worksheet =
    workbook.worksheets.find((sheet) => Number(sheet.actualRowCount || 0) > 0) ||
    workbook.worksheets[0];

  if (!worksheet) {
    return [];
  }

  let headers = null;
  const rows = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = getExcelRowValues(row);
    const hasValues = values.some(Boolean);

    if (!hasValues) {
      return;
    }

    if (!headers) {
      headers = values;
      return;
    }

    const item = {};

    headers.forEach((header, index) => {
      if (header) {
        item[header] = values[index] || "";
      }
    });

    if (Object.keys(item).length > 0) {
      rows.push(item);
    }
  });

  return rows;
}

async function parseSheetRows(content, attachment) {
  if (isCsvAttachment(attachment)) {
    return parseCsvRows(content);
  }

  if (isExcelAttachment(attachment)) {
    return parseExcelRows(content);
  }

  const extension = getAttachmentExtension(attachment);
  const error = new Error(
    extension
      ? `Unsupported inventory sheet file type: .${extension}`
      : "Unsupported inventory sheet file type."
  );

  error.statusCode = 415;
  throw error;
}

async function importSheetAttachment({ settings, attachment, message }) {
  const content = attachment.content || Buffer.alloc(0);
  const attachmentHash = getAttachmentHash(content);

  if (await importsService.hasProcessedAttachment(settings.vendorId, attachmentHash)) {
    await importsService.touchProcessedAttachment({
      vendorId: settings.vendorId,
      messageUid: message.uid,
      messageId: message.messageId,
      senderEmail: settings.senderEmail,
      attachmentFilename: attachment.filename,
      attachmentHash
    });

    return {
      imported: 0,
      skipped: 0,
      errors: 0,
      duplicate: true
    };
  }

  let rows;

  try {
    rows = await parseSheetRows(content, attachment);
  } catch (error) {
    await notifyAutoInventoryFailure({
      settings,
      attachment,
      attachmentHash,
      reason: "Inventory sheet could not be parsed",
      details: error.message
    });
    await importsService.recordImport({
      vendorId: settings.vendorId,
      messageUid: message.uid,
      messageId: message.messageId,
      senderEmail: settings.senderEmail,
      attachmentFilename: attachment.filename,
      attachmentHash,
      errorCount: 1,
      status: "failed",
      errorMessage: error.message
    });
    return {
      imported: 0,
      skipped: 0,
      errors: 1,
      duplicate: false
    };
  }

  if (rows.length === 0) {
    await notifyAutoInventoryFailure({
      settings,
      attachment,
      attachmentHash,
      reason: "Inventory sheet did not contain any rows"
    });
    await importsService.recordImport({
      vendorId: settings.vendorId,
      messageUid: message.uid,
      messageId: message.messageId,
      senderEmail: settings.senderEmail,
      attachmentFilename: attachment.filename,
      attachmentHash,
      errorCount: 1,
      status: "failed",
      errorMessage: "Inventory sheet did not contain any rows."
    });

    return {
      imported: 0,
      skipped: 0,
      errors: 1,
      duplicate: false
    };
  }

  const firstRow = rows[0] || {};
  const missingHeaders = [
    !hasHeader(firstRow, settings.skuHeader) ? settings.skuHeader : "",
    !hasHeader(firstRow, settings.inventoryHeader) ? settings.inventoryHeader : "",
    settings.inventoryMode !== "alphabetical" &&
    settings.subtractiveColumn &&
    !hasHeader(firstRow, settings.subtractiveColumn)
      ? settings.subtractiveColumn
      : ""
  ].filter(Boolean);

  if (missingHeaders.length > 0) {
    const availableHeaders = Object.keys(firstRow)
      .map((header) => header.replace(/^\uFEFF/, ""))
      .filter(Boolean)
      .join(", ");

    await notifyAutoInventoryFailure({
      settings,
      attachment,
      attachmentHash,
      reason: "Configured inventory sheet header was not found",
      details: `Missing: ${missingHeaders.join(", ")}. Available headers: ${availableHeaders || "none"}.`
    });
    await importsService.recordImport({
      vendorId: settings.vendorId,
      messageUid: message.uid,
      messageId: message.messageId,
      senderEmail: settings.senderEmail,
      attachmentFilename: attachment.filename,
      attachmentHash,
      errorCount: 1,
      status: "failed",
      errorMessage: `Missing header(s): ${missingHeaders.join(", ")}`
    });

    return {
      imported: 0,
      skipped: rows.length,
      errors: 1,
      duplicate: false
    };
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  const missingSkuSamples = [];
  const unmatchedInventorySamples = [];
  const updateErrorSamples = [];
  const sheetSkuKeys = new Set();
  const vendorProducts =
    await catalogService.getActiveCatalogVendorProductsByVendorId(
      settings.vendorId
    );
  const vendorProductLookup = buildVendorProductSkuLookup(vendorProducts);
  const skuExceptionKeys = buildSkuExceptionKeys(settings.skuExceptions);

  for (const row of rows) {
    const sku = findHeaderValue(row, settings.skuHeader);
    const inventoryValue = findHeaderValue(row, settings.inventoryHeader);
    const subtractiveValue =
      settings.inventoryMode !== "alphabetical" && settings.subtractiveColumn
        ? findHeaderValue(row, settings.subtractiveColumn)
        : "";

    if (sku) {
      addSkuMatchKeys(sheetSkuKeys, sku);
    }

    if (!sku) {
      skipped += 1;

      if (missingSkuSamples.length < 5) {
        missingSkuSamples.push(JSON.stringify(row).slice(0, 180));
      }

      continue;
    }

    const vendorProduct = findVendorProductForSheetSku(vendorProductLookup, sku);

    if (!vendorProduct) {
      skipped += 1;
      continue;
    }

    const quantity = parseInventoryQuantity(
      inventoryValue,
      settings,
      subtractiveValue
    );

    if (quantity === null) {
      skipped += 1;

      if (unmatchedInventorySamples.length < 5) {
        unmatchedInventorySamples.push(
          settings.inventoryMode !== "alphabetical" && settings.subtractiveColumn
            ? `${sku} => ${settings.inventoryHeader}: ${inventoryValue || "blank"}, ${settings.subtractiveColumn}: ${subtractiveValue || "blank"}`
            : `${sku} => ${inventoryValue || "blank"}`
        );
      }

      continue;
    }

    try {
      const currentIsAvailable = Number(vendorProduct.quantity || 0) > 0;
      const nextIsAvailable = quantity > 0;

      if (currentIsAvailable === nextIsAvailable) {
        skipped += 1;
        continue;
      }

      await productsService.setVendorProductQuantity({
        vendorId: settings.vendorId,
        vendorProductId: vendorProduct.id,
        quantity,
        vendorProduct
      });
      imported += 1;
    } catch (error) {
      errors += 1;
      if (updateErrorSamples.length < 5) {
        updateErrorSamples.push(`${sku}: ${error.message}`);
      }
      console.error("Auto inventory row import failed.", {
        vendorId: settings.vendorId,
        sku,
        error: error.message
      });
    }
  }

  const failureDetails = [];

  if (missingSkuSamples.length > 0) {
    failureDetails.push(`Rows missing SKU: ${missingSkuSamples.join(" | ")}`);
  }

  if (unmatchedInventorySamples.length > 0) {
    const modeDetails =
      settings.inventoryMode === "alphabetical"
        ? `Expected in-stock phrases: ${settings.inStockPhrases.join(" : ") || "none"}; out-of-stock phrases: ${settings.outOfStockPhrases.join(" : ") || "none"}.`
        : settings.subtractiveColumn
          ? `Expected numerical values for ${settings.inventoryHeader} and ${settings.subtractiveColumn}.`
          : "Expected a numerical inventory value.";

    failureDetails.push(
      `Unrecognized inventory values: ${unmatchedInventorySamples.join(" | ")}. ${modeDetails}`
    );
  }

  if (updateErrorSamples.length > 0) {
    failureDetails.push(`SKU Nexus update errors: ${updateErrorSamples.join(" | ")}`);
  }

  const missingVendorProducts = vendorProducts.filter(
    (vendorProduct) =>
      !isVendorProductExcepted(vendorProduct, skuExceptionKeys) &&
      !isVendorProductRepresentedInSheet(vendorProduct, sheetSkuKeys)
  );

  if (missingVendorProducts.length > 0) {
    failureDetails.push(formatMissingVendorProducts(missingVendorProducts));
  }

  if (failureDetails.length > 0) {
    await notifyAutoInventoryFailure({
      settings,
      attachment,
      attachmentHash,
      reason: "Some inventory rows could not be imported",
      details: failureDetails.join(" ")
    });
  }

  await importsService.recordImport({
    vendorId: settings.vendorId,
    messageUid: message.uid,
    messageId: message.messageId,
    senderEmail: settings.senderEmail,
    attachmentFilename: attachment.filename,
    attachmentHash,
    importedCount: imported,
    skippedCount: skipped,
    errorCount: errors,
    status:
      errors > 0 || failureDetails.length > 0
        ? "completed_with_errors"
        : "completed",
    errorMessage: failureDetails.join(" ").slice(0, 1000)
  });

  return {
    imported,
    skipped,
    errors,
    duplicate: false
  };
}

async function processMessageForSettings({ uid, source }, settings) {
  const parsed = await simpleParser(source);
  const senderEmails = getSenderEmails(parsed);

  if (!senderEmails.includes(settings.senderEmail)) {
    return {
      imported: 0,
      skipped: 0,
      errors: 0,
      attachments: 0,
      shouldLabel: false
    };
  }

  const sheetAttachments = (parsed.attachments || []).filter(
    isInventorySheetAttachment
  );
  const totals = {
    imported: 0,
    skipped: 0,
    errors: 0,
    attachments: 0,
    shouldLabel: sheetAttachments.length > 0
  };

  for (const attachment of sheetAttachments) {
    const result = await importSheetAttachment({
      settings,
      attachment,
      message: {
        uid: String(uid),
        messageId: normalizeText(parsed.messageId)
      }
    });

    totals.attachments += result.duplicate ? 0 : 1;
    totals.imported += result.imported;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  return totals;
}

async function shouldLabelMessageForSettings({ source }, settings) {
  const parsed = await simpleParser(source);
  const senderEmails = getSenderEmails(parsed);

  if (!senderEmails.includes(settings.senderEmail)) {
    return false;
  }

  return (parsed.attachments || []).some(isInventorySheetAttachment);
}

async function applyVendorInventoryLabel(client, uid) {
  if (!vendorInventoryLabel) {
    return false;
  }

  await client.messageFlagsAdd(
    String(uid),
    [vendorInventoryLabel],
    {
      uid: true,
      useLabels: true
    }
  );

  await archiveVendorInventoryEmail(client, uid);

  return true;
}

async function getArchiveMailboxPath(client) {
  const mailboxes = await client.list();
  const archiveMailbox = mailboxes.find(
    (mailbox) =>
      mailbox?.specialUse === "\\All" ||
      mailbox?.specialUse === "\\Archive"
  );

  return archiveMailbox?.path || "[Gmail]/All Mail";
}

async function archiveVendorInventoryEmail(client, uid) {
  const archiveMailboxPath = await getArchiveMailboxPath(client);

  try {
    const moved = await client.messageMove(String(uid), archiveMailboxPath, {
      uid: true
    });

    if (moved) {
      return true;
    }
  } catch (error) {
    console.warn("Unable to move vendor inventory email to archive mailbox.", {
      uid,
      archiveMailboxPath,
      error: error.message
    });
  }

  await client.messageFlagsRemove(String(uid), gmailInboxLabels, {
    uid: true,
    useLabels: true
  });

  return true;
}

async function runAutoInventoryImport() {
  const settingsList = await settingsService.getEnabledSettings();

  if (settingsList.length === 0) {
    return {
      ok: true,
      vendors: 0,
      messages: 0,
      attachments: 0,
      labeled: 0,
      imported: 0,
      skipped: 0,
      errors: 0
    };
  }

  const client = new ImapFlow(getImapConfig());
  const totals = {
    ok: true,
    vendors: settingsList.length,
    messages: 0,
    attachments: 0,
    labeled: 0,
    imported: 0,
    skipped: 0,
    errors: 0
  };
  const labeledUids = new Set();

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const since = getLookbackDate();

    for (const settings of settingsList) {
      const uids =
        (await client.search(
          {
            from: settings.senderEmail,
            since
          },
          { uid: true }
        )) || [];
      const messages = [];

      for (const uid of uids) {
        const message = await client.fetchOne(
          String(uid),
          { internalDate: true, source: true },
          { uid: true }
        );

        if (!message?.source) {
          continue;
        }

        messages.push({
          uid,
          internalDate: message.internalDate,
          source: message.source
        });
      }

      const latestMessage = getLatestMessage(messages);

      if (!latestMessage) {
        continue;
      }

      for (const message of messages) {
        const labelKey = String(message.uid);

        if (labeledUids.has(labelKey)) {
          continue;
        }

        let shouldLabel = false;

        try {
          shouldLabel = await shouldLabelMessageForSettings(message, settings);
        } catch (error) {
          totals.errors += 1;
          console.error("Unable to inspect vendor inventory email for labeling.", {
            uid: message.uid,
            label: vendorInventoryLabel,
            error: error.message
          });
          continue;
        }

        if (!shouldLabel) {
          continue;
        }

        try {
          if (await applyVendorInventoryLabel(client, message.uid)) {
            labeledUids.add(labelKey);
            totals.labeled += 1;
          }
        } catch (error) {
          totals.errors += 1;
          console.error("Unable to label or archive vendor inventory email.", {
            uid: message.uid,
            label: vendorInventoryLabel,
            error: error.message
          });
        }
      }

      totals.messages += 1;
      const result = await processMessageForSettings(
        {
          uid: latestMessage.uid,
          source: latestMessage.source
        },
        settings
      );

      totals.attachments += result.attachments;
      totals.imported += result.imported;
      totals.skipped += result.skipped;
      totals.errors += result.errors;
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return totals;
}

module.exports = {
  runAutoInventoryImport
};
