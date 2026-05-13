import { useCallback, useEffect, useState } from "react";
import { getNotifications, markNotificationRead } from "../../services/api";
import type { AppNotification } from "../../types";
import {
  formatNotificationTimestamp,
  getNotificationLine,
  getNotificationTarget,
  isSystemNotification
} from "./notificationDisplay";
import { SystemNotificationModal } from "./SystemNotificationModal";

type NotificationsPageProps = {
  onOpenSku: (sku: string) => void;
};

export function NotificationsPage({ onOpenSku }: NotificationsPageProps) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedSystemNotification, setSelectedSystemNotification] =
    useState<AppNotification | null>(null);

  const loadNotifications = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const result = await getNotifications({ limit: 100 });
      setNotifications(result.items);
      setUnreadCount(result.unreadCount);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load notifications."
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  async function markAsRead(notification: AppNotification) {
    if (notification.read_at) {
      return;
    }

    const readAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) =>
        item.id === notification.id ? { ...item, read_at: readAt } : item
      )
    );
    setUnreadCount((current) => Math.max(0, current - 1));

    try {
      await markNotificationRead(notification.id);
    } catch (err) {
      void loadNotifications();
    }
  }

  async function handleNotificationClick(notification: AppNotification) {
    await markAsRead(notification);

    if (isSystemNotification(notification)) {
      setSelectedSystemNotification(notification);
      return;
    }

    onOpenSku(notification.sku);
  }

  return (
    <section
      className="page notifications-page"
      aria-labelledby="notificationsHeading"
    >
      <div className="notifications-page-header">
        <div>
          <p className="eyebrow">StockBridge</p>
          <h1 id="notificationsHeading">Notifications</h1>
        </div>
        <span>{unreadCount > 0 ? `${unreadCount} unread` : "Up to date"}</span>
      </div>

      {isLoading ? (
        <p className="status-message">Loading notifications...</p>
      ) : error ? (
        <p className="status-message error-message">{error}</p>
      ) : notifications.length === 0 ? (
        <p className="status-message">No notifications yet.</p>
      ) : (
        <div className="notifications-page-list">
          {notifications.map((notification) => (
            <button
              key={notification.id}
              type="button"
              className={`notification-row${
                notification.read_at ? "" : " unread"
              }${isSystemNotification(notification) ? " system" : ""}`}
              onClick={() => handleNotificationClick(notification)}
            >
              <span className="notification-row-status">
                {notification.read_at ? "Read" : "Unread"}
              </span>
              <span className="notification-row-main">
                <strong>{notification.sender.name}</strong>
                <span>
                  {getNotificationLine(notification)}{" "}
                  <mark>{getNotificationTarget(notification)}</mark>
                </span>
                {notification.notePreview && (
                  <small>{notification.notePreview}</small>
                )}
              </span>
              <time dateTime={notification.created_at}>
                {formatNotificationTimestamp(notification.created_at)}
              </time>
            </button>
          ))}
        </div>
      )}

      {selectedSystemNotification && (
        <SystemNotificationModal
          notification={selectedSystemNotification}
          onClose={() => setSelectedSystemNotification(null)}
        />
      )}
    </section>
  );
}
