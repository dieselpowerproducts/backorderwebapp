import { useCallback, useEffect, useRef, useState } from "react";
import { getNotifications, markNotificationRead } from "../../services/api";
import { updateFaviconBadge } from "../../utils/faviconBadge";
import type { AppNotification } from "../../types";

type NotificationsMenuProps = {
  onOpenSku: (sku: string) => void;
};

const autoInventorySku = "AUTO-INVENTORY";
const dropdownPreviewLength = 180;
const notificationFocusRefreshMinMs = 60 * 1000;

function formatNotificationTimestamp(value: string) {
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

function isSystemNotification(notification: AppNotification) {
  return (
    notification.sku.toUpperCase() === autoInventorySku ||
    notification.noteId.startsWith("auto-inventory:") ||
    notification.sender.sub.startsWith("system:")
  );
}

function getNotificationLine(notification: AppNotification) {
  if (isSystemNotification(notification)) {
    return notification.sku.toUpperCase() === autoInventorySku
      ? "Auto inventory failsafe"
      : "System notification";
  }

  return "mentioned you on";
}

function getNotificationTarget(notification: AppNotification) {
  return isSystemNotification(notification) ? "Details" : notification.sku;
}

function getSystemNotificationTitle(notification: AppNotification) {
  return notification.sku.toUpperCase() === autoInventorySku
    ? "Auto Inventory Failsafe"
    : "System Notification";
}

function getDropdownPreview(value: string) {
  if (value.length <= dropdownPreviewLength) {
    return value;
  }

  return `${value.slice(0, dropdownPreviewLength - 3).trimEnd()}...`;
}

export function NotificationsMenu({ onOpenSku }: NotificationsMenuProps) {
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
        const result = await getNotifications();
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
      const readAt = new Date().toISOString();

      setNotifications((current) =>
        current.map((item) =>
          item.id === notification.id
            ? {
                ...item,
                read_at: readAt
              }
            : item
        )
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

          {isLoading ? (
            <p className="notifications-status">Loading notifications...</p>
          ) : error ? (
            <p className="notifications-status error-message">{error}</p>
          ) : notifications.length === 0 ? (
            <p className="notifications-status">No notifications yet.</p>
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
      <div
        className="modal system-notification-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="systemNotificationTitle"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setSelectedSystemNotification(null);
          }
        }}
      >
        <section className="modal-content system-notification-modal">
          <header className="system-notification-modal-header">
            <div>
              <p className="eyebrow">StockBridge</p>
              <h2 id="systemNotificationTitle">
                {getSystemNotificationTitle(selectedSystemNotification)}
              </h2>
            </div>
            <button
              type="button"
              aria-label="Close notification details"
              onClick={() => setSelectedSystemNotification(null)}
            >
              Close
            </button>
          </header>

          <dl className="system-notification-meta">
            <div>
              <dt>Sent</dt>
              <dd>
                {formatNotificationTimestamp(
                  selectedSystemNotification.created_at
                )}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{selectedSystemNotification.sender.name}</dd>
            </div>
          </dl>

          <div className="system-notification-detail">
            {selectedSystemNotification.notePreview ||
              "No details were included with this notification."}
          </div>
        </section>
      </div>
    )}
    </>
  );
}
