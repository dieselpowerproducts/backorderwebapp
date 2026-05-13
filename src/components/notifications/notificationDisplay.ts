import type { AppNotification } from "../../types";

const autoInventorySku = "AUTO-INVENTORY";
const dropdownPreviewLength = 180;

export function formatNotificationTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isSameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function isSystemNotification(notification: AppNotification) {
  return (
    notification.sku.toUpperCase() === autoInventorySku ||
    notification.noteId.startsWith("auto-inventory:") ||
    notification.sender.sub.startsWith("system:")
  );
}

export function getNotificationLine(notification: AppNotification) {
  if (isSystemNotification(notification)) {
    return notification.sku.toUpperCase() === autoInventorySku
      ? "Auto inventory failsafe"
      : "System notification";
  }

  return "mentioned you on";
}

export function getNotificationTarget(notification: AppNotification) {
  return isSystemNotification(notification) ? "Details" : notification.sku;
}

export function getSystemNotificationTitle(notification: AppNotification) {
  return notification.sku.toUpperCase() === autoInventorySku
    ? "Auto Inventory Failsafe"
    : "System Notification";
}

export function getDropdownPreview(value: string) {
  if (value.length <= dropdownPreviewLength) {
    return value;
  }

  return `${value.slice(0, dropdownPreviewLength - 3).trimEnd()}...`;
}
