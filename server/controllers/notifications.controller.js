const notificationsService = require("../services/notifications.service");

async function listNotifications(req, res, next) {
  try {
    const result = await notificationsService.getNotificationsForUser(req.user, {
      limit: req.query.limit,
      unreadOnly: req.query.unreadOnly === "1" || req.query.unreadOnly === "true"
    });
    res.send(result);
  } catch (err) {
    next(err);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const result = await notificationsService.markNotificationRead(
      req.params.id,
      req.user
    );
    res.send({ updated: result.changes });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listNotifications,
  markNotificationRead
};
