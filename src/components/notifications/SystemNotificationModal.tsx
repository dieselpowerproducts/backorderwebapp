import type { AppNotification } from "../../types";
import {
  formatNotificationTimestamp,
  getSystemNotificationTitle
} from "./notificationDisplay";

type SystemNotificationModalProps = {
  notification: AppNotification;
  onClose: () => void;
};

export function SystemNotificationModal({
  notification,
  onClose
}: SystemNotificationModalProps) {
  return (
    <div
      className="modal system-notification-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="systemNotificationTitle"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="modal-content system-notification-modal">
        <header className="system-notification-modal-header">
          <div>
            <p className="eyebrow">StockBridge</p>
            <h2 id="systemNotificationTitle">
              {getSystemNotificationTitle(notification)}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close notification details"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <dl className="system-notification-meta">
          <div>
            <dt>Sent</dt>
            <dd>{formatNotificationTimestamp(notification.created_at)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{notification.sender.name}</dd>
          </div>
        </dl>

        <div className="system-notification-detail">
          {notification.notePreview ||
            "No details were included with this notification."}
        </div>
      </section>
    </div>
  );
}
