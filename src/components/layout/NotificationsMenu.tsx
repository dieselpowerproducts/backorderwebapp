import { useCallback, useEffect, useRef, useState } from "react";
import { getNotifications, markNotificationRead } from "../../services/api";
import { SystemNotificationModal } from "../notifications/SystemNotificationModal";
import {
  formatNotificationTimestamp,
  getDropdownPreview,
  getNotificationLine,
  getNotificationTarget,
  isSystemNotification
} from "../notifications/notificationDisplay";
import { updateFaviconBadge } from "../../utils/faviconBadge";
import type { AppNotification } from "../../types";

type NotificationsMenuProps = {
  onOpenSku: (sku: string) => void;
  onViewAll: () => void;
};

const notificationFocusRefreshMinMs = 5 * 60 * 1000;

export function NotificationsMenu({ onOpenSku, onViewAll }: NotificationsMenuProps) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedSystemNotification, setSelectedSystemNotification] =
    useState<AppNotification | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastLoadedAtRef = useRef(0);
  const inFlightRef = useRef(false);

  const loadNotifications = useCallback(
    async (showSpinner = false) => {
      if (inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;

      if (showSpinner) {
        setIsLoading(true);
      }

      setError("");

      try {
        const result = await getNotifications({ limit: 20, unreadOnly: true });
        setNotifications(result.items);
        setUnreadCount(result.unreadCount);
        lastLoadedAtRef.current = Date.now();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to load notifications."
        );
      } finally {
        inFlightRef.current = false;

        if (showSpinner) {
          setIsLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    loadNotifications(true);

    const loadStaleNotifications = () => {
      if (Date.now() - lastLoadedAtRef.current >= notificationFocusRefreshMinMs) {
        void loadNotifications();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadStaleNotifications();
      }
    };

    window.addEventListener("focus", loadStaleNotifications);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", loadStaleNotifications);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadNotifications]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    void loadNotifications();
  }, [isOpen, loadNotifications]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  useEffect(() => {
    void updateFaviconBadge(unreadCount).catch((error) => {
      console.error("Unable to update favicon badge.", error);
    });
  }, [unreadCount]);

  async function markNotificationAsRead(notification: AppNotification) {
    if (!notification.read_at) {
      setNotifications((current) =>
        current.filter((item) => item.id !== notification.id)
      );
      setUnreadCount((current) => Math.max(0, current - 1));

      try {
        await markNotificationRead(notification.id);
      } catch (err) {
        void loadNotifications();
      }
    }
  }

  async function handleNotificationClick(notification: AppNotification) {
    setIsOpen(false);
    await markNotificationAsRead(notification);

    if (isSystemNotification(notification)) {
      setSelectedSystemNotification(notification);
      return;
    }

    onOpenSku(notification.sku);
  }

  function handleViewAll() {
    setIsOpen(false);
    onViewAll();
  }

  return (
    <>
    <div className="notification-shell" ref={containerRef}>
      <button
        type="button"
        className="notification-button"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
          <path d="M12 3a5 5 0 0 0-5 5v2.4c0 .8-.3 1.6-.8 2.2L4.7 14c-.5.6-.7 1.3-.7 2h16c0-.7-.2-1.4-.7-2l-1.5-1.4c-.5-.6-.8-1.4-.8-2.2V8a5 5 0 0 0-5-5Zm0 18a2.5 2.5 0 0 0 2.4-2h-4.8A2.5 2.5 0 0 0 12 21Z" />
        </svg>
        {unreadCount > 0 && (
          <span className="notification-badge" aria-hidden="true">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="notifications-dropdown" role="menu" aria-label="Notifications">
          <div className="notifications-dropdown-header">
            <strong>Notifications</strong>
            <span>{unreadCount > 0 ? `${unreadCount} unread` : "Up to date"}</span>
          </div>
          <div className="notifications-dropdown-actions">
            <button type="button" onClick={handleViewAll}>
              View all
            </button>
          </div>

          {isLoading ? (
            <p className="notifications-status">Loading notifications...</p>
          ) : error ? (
            <p className="notifications-status error-message">{error}</p>
          ) : notifications.length === 0 ? (
            <p className="notifications-status">No unread notifications.</p>
          ) : (
            <div className="notifications-list">
              {notifications.map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  className={`notification-item${
                    notification.read_at ? "" : " unread"
                  }${isSystemNotification(notification) ? " system" : ""}`}
                  onClick={() => handleNotificationClick(notification)}
                >
                  <div className="notification-item-header">
                    <strong>{notification.sender.name}</strong>
                    <time dateTime={notification.created_at}>
                      {formatNotificationTimestamp(notification.created_at)}
                    </time>
                  </div>
                  <div className="notification-item-line">
                    {getNotificationLine(notification)}{" "}
                    <span>{getNotificationTarget(notification)}</span>
                  </div>
                  {notification.notePreview && (
                    <p className="notification-item-preview">
                      {getDropdownPreview(notification.notePreview)}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    {selectedSystemNotification && (
      <SystemNotificationModal
        notification={selectedSystemNotification}
        onClose={() => setSelectedSystemNotification(null)}
      />
    )}
    </>
  );
}
