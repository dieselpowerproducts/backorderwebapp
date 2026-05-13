const { getSql } = require("../db/neon");
const usersService = require("./users.service");

let schemaReady;

function getSafeId(id) {
  const safeId = Number.parseInt(id, 10);

  if (!Number.isSafeInteger(safeId) || safeId < 1) {
    const error = new Error("Invalid notification id.");
    error.statusCode = 400;
    throw error;
  }

  return safeId;
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function compactAlias(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getUserAliases(user) {
  const aliases = new Set();
  const safeName = normalizeText(user?.name);
  const safeEmail = normalizeText(user?.email).toLowerCase();
  const emailLocal = safeEmail.split("@")[0] || "";

  if (safeName) {
    aliases.add(safeName.toLowerCase());
  }

  if (safeEmail) {
    aliases.add(safeEmail);
  }

  if (emailLocal) {
    aliases.add(emailLocal);
  }

  const compactName = compactAlias(safeName);
  const compactEmailLocal = compactAlias(emailLocal);

  if (compactName) {
    aliases.add(compactName);
  }

  if (compactEmailLocal) {
    aliases.add(compactEmailLocal);
  }

  return Array.from(aliases).filter((alias) => alias.length >= 2);
}

function buildMentionAliases(users) {
  const aliasesByValue = new Map();
  const conflictedAliases = new Set();

  for (const user of users) {
    for (const alias of getUserAliases(user)) {
      const existing = aliasesByValue.get(alias);

      if (!existing) {
        aliasesByValue.set(alias, user);
        continue;
      }

      if (existing.sub !== user.sub) {
        conflictedAliases.add(alias);
      }
    }
  }

  for (const alias of conflictedAliases) {
    aliasesByValue.delete(alias);
  }

  return Array.from(aliasesByValue.entries()).sort(
    (left, right) => right[0].length - left[0].length
  );
}

function isAliasBoundary(character) {
  return !character || /[\s.,!?;:()[\]{}<>"'`/\\|+-]/.test(character);
}

function extractMentionedUsers(note, users, senderSub, senderEmail = "") {
  const safeNote = String(note || "");
  const normalizedNote = safeNote.toLowerCase();
  const aliases = buildMentionAliases(users);
  const mentionedUsers = new Map();
  const normalizedSenderEmail = normalizeText(senderEmail).toLowerCase();

  for (let index = 0; index < normalizedNote.length; index += 1) {
    if (normalizedNote[index] !== "@") {
      continue;
    }

    const remainder = normalizedNote.slice(index + 1);

    for (const [alias, user] of aliases) {
      if (!remainder.startsWith(alias) || !isAliasBoundary(remainder[alias.length])) {
        continue;
      }

      const userEmail = normalizeText(user?.email).toLowerCase();

      if (
        user.sub &&
        user.sub !== senderSub &&
        (!normalizedSenderEmail || userEmail !== normalizedSenderEmail)
      ) {
        mentionedUsers.set(user.sub, user);
      }

      break;
    }
  }

  return Array.from(mentionedUsers.values());
}

function buildNotePreview(note) {
  const safeNote = normalizeText(note);

  if (safeNote.length <= 140) {
    return safeNote;
  }

  return `${safeNote.slice(0, 137).trimEnd()}...`;
}

function formatNotification(row) {
  return {
    id: String(row.id),
    sku: row.sku || "",
    noteId: String(row.note_id || ""),
    notePreview: row.note_preview || "",
    sender: {
      sub: row.sender_sub || "",
      email: row.sender_email || "",
      name: row.sender_name || row.sender_email || "StockBridge",
      picture: row.sender_picture || ""
    },
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    read_at: row.read_at ? new Date(row.read_at).toISOString() : ""
  };
}

async function initializeSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS product_notifications (
          id BIGSERIAL PRIMARY KEY,
          recipient_sub TEXT NOT NULL,
          recipient_email TEXT,
          recipient_name TEXT NOT NULL,
          recipient_picture TEXT,
          sender_sub TEXT,
          sender_email TEXT,
          sender_name TEXT NOT NULL,
          sender_picture TEXT,
          sku TEXT NOT NULL,
          note_id TEXT NOT NULL,
          note_preview TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          read_at TIMESTAMPTZ,
          UNIQUE (recipient_sub, note_id)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS product_notifications_recipient_idx
        ON product_notifications (recipient_sub, created_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS product_notifications_note_idx
        ON product_notifications (note_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS product_notifications_unread_idx
        ON product_notifications (recipient_sub, read_at)
      `;
    })();
  }

  return schemaReady;
}

async function deleteNotificationsForNoteId(noteId) {
  const safeNoteId = String(noteId || "").trim();

  if (!safeNoteId) {
    return;
  }

  await initializeSchema();

  const sql = getSql();
  await sql`
    DELETE FROM product_notifications
    WHERE note_id = ${safeNoteId}
  `;
}

async function syncNoteNotifications({ noteId, sku, note, sender }) {
  const safeNoteId = String(noteId || "").trim();
  const safeSku = String(sku || "").trim();

  if (!safeNoteId || !safeSku) {
    return { count: 0 };
  }

  await initializeSchema();
  await deleteNotificationsForNoteId(safeNoteId);

  const recipients = extractMentionedUsers(
    note,
    await usersService.listUsers(),
    String(sender?.sub || "").trim(),
    String(sender?.email || "").trim().toLowerCase()
  );

  if (recipients.length === 0) {
    return { count: 0 };
  }

  const safeSender = {
    sub: String(sender?.sub || "").trim(),
    email: String(sender?.email || "").trim().toLowerCase(),
    name: normalizeText(sender?.name || sender?.email || "StockBridge"),
    picture: String(sender?.picture || "").trim()
  };
  const notePreview = buildNotePreview(note);
  const sql = getSql();

  for (const recipient of recipients) {
    await sql`
      INSERT INTO product_notifications (
        recipient_sub,
        recipient_email,
        recipient_name,
        recipient_picture,
        sender_sub,
        sender_email,
        sender_name,
        sender_picture,
        sku,
        note_id,
        note_preview
      )
      VALUES (
        ${recipient.sub},
        ${recipient.email || null},
        ${recipient.name || recipient.email},
        ${recipient.picture || null},
        ${safeSender.sub || null},
        ${safeSender.email || null},
        ${safeSender.name},
        ${safeSender.picture || null},
        ${safeSku},
        ${safeNoteId},
        ${notePreview}
      )
      ON CONFLICT (recipient_sub, note_id) DO UPDATE
      SET recipient_email = EXCLUDED.recipient_email,
          recipient_name = EXCLUDED.recipient_name,
          recipient_picture = EXCLUDED.recipient_picture,
          sender_sub = EXCLUDED.sender_sub,
          sender_email = EXCLUDED.sender_email,
          sender_name = EXCLUDED.sender_name,
          sender_picture = EXCLUDED.sender_picture,
          sku = EXCLUDED.sku,
          note_preview = EXCLUDED.note_preview,
          created_at = now(),
          read_at = NULL
    `;
  }

  return { count: recipients.length };
}

async function createSystemNotification({
  recipientEmail,
  recipientName = "",
  sku = "AUTO-INVENTORY",
  noteId,
  notePreview,
  senderName = "StockBridge"
}) {
  const safeRecipientEmail = normalizeText(recipientEmail).toLowerCase();
  const safeNoteId = String(noteId || "").trim();
  const safeNotePreview = normalizeText(notePreview);

  if (!safeRecipientEmail || !safeNoteId || !safeNotePreview) {
    return { count: 0 };
  }

  await initializeSchema();

  const users = await usersService.listUsers();
  const recipient =
    users.find(
      (user) => normalizeText(user?.email).toLowerCase() === safeRecipientEmail
    ) || {};
  const recipientSub =
    String(recipient?.sub || "").trim() || `system:${safeRecipientEmail}`;
  const sql = getSql();

  await sql`
    INSERT INTO product_notifications (
      recipient_sub,
      recipient_email,
      recipient_name,
      recipient_picture,
      sender_sub,
      sender_email,
      sender_name,
      sender_picture,
      sku,
      note_id,
      note_preview
    )
    VALUES (
      ${recipientSub},
      ${safeRecipientEmail},
      ${normalizeText(recipient?.name || recipientName || safeRecipientEmail)},
      ${recipient?.picture || null},
      ${"system:auto-inventory"},
      ${null},
      ${normalizeText(senderName) || "StockBridge"},
      ${null},
      ${normalizeText(sku) || "AUTO-INVENTORY"},
      ${safeNoteId},
      ${safeNotePreview}
    )
    ON CONFLICT (recipient_sub, note_id) DO UPDATE
    SET recipient_email = EXCLUDED.recipient_email,
        recipient_name = EXCLUDED.recipient_name,
        recipient_picture = EXCLUDED.recipient_picture,
        sender_sub = EXCLUDED.sender_sub,
        sender_email = EXCLUDED.sender_email,
        sender_name = EXCLUDED.sender_name,
        sender_picture = EXCLUDED.sender_picture,
        sku = EXCLUDED.sku,
        note_preview = EXCLUDED.note_preview,
        created_at = now(),
        read_at = NULL
  `;

  return { count: 1 };
}

function buildRecipientConditions(user) {
  const safeUserSub = String(user?.sub || user || "").trim();
  const safeUserEmail = normalizeText(user?.email || "").toLowerCase();

  return {
    safeUserEmail,
    safeUserSub
  };
}

async function getNotificationsForUser(user, { limit = 20, unreadOnly = false } = {}) {
  const { safeUserSub, safeUserEmail } = buildRecipientConditions(user);

  if (!safeUserSub && !safeUserEmail) {
    return {
      items: [],
      unreadCount: 0
    };
  }

  await initializeSchema();

  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 200);
  const sql = getSql();
  const [rows, unreadRows] = await Promise.all([
    sql`
      SELECT
        id::text,
        sku,
        note_id,
        note_preview,
        sender_sub,
        sender_email,
        sender_name,
        sender_picture,
        created_at,
        read_at
      FROM product_notifications
      WHERE (
        recipient_sub = ${safeUserSub}
        OR (
          ${safeUserEmail} <> ''
          AND lower(COALESCE(recipient_email, '')) = ${safeUserEmail}
        )
      )
        AND (${Boolean(unreadOnly)} = false OR read_at IS NULL)
      ORDER BY read_at ASC NULLS FIRST, created_at DESC
      LIMIT ${safeLimit}
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM product_notifications
      WHERE (
        recipient_sub = ${safeUserSub}
        OR (
          ${safeUserEmail} <> ''
          AND lower(COALESCE(recipient_email, '')) = ${safeUserEmail}
        )
      )
        AND read_at IS NULL
    `
  ]);

  return {
    items: rows.map(formatNotification),
    unreadCount: Number(unreadRows[0]?.count || 0)
  };
}

async function markNotificationRead(id, user) {
  await initializeSchema();

  const { safeUserSub, safeUserEmail } = buildRecipientConditions(user);
  const sql = getSql();
  const rows = await sql`
    UPDATE product_notifications
    SET read_at = COALESCE(read_at, now())
    WHERE id = ${getSafeId(id)}
      AND (
        recipient_sub = ${safeUserSub}
        OR (
          ${safeUserEmail} <> ''
          AND lower(COALESCE(recipient_email, '')) = ${safeUserEmail}
        )
      )
    RETURNING id
  `;

  return {
    changes: rows.length
  };
}

module.exports = {
  createSystemNotification,
  deleteNotificationsForNoteId,
  getNotificationsForUser,
  markNotificationRead,
  syncNoteNotifications
};
