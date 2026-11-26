// routes/cron.js
//
// Scheduled background jobs, triggered by Vercel Cron (see vercel.json's
// "crons" entry) rather than by any user action. Vercel Cron calls these
// as plain HTTP GET requests on a schedule — there's no logged-in user
// making the request, so authentication here is a shared secret
// (CRON_SECRET) instead of the normal JWT middleware, same idea as
// SMS_WEBHOOK_SECRET for the SMS webhook.
const express = require('express');
const router = express.Router();
const firebaseService = require('../services/firebaseService');
const paytmService = require('../services/paytmService');
const fampayService = require('../services/fampayService');
const logger = require('../utils/logger');

function requireCronSecret(req, res, next) {
  const provided = req.headers['authorization']?.replace('Bearer ', '') || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

/**
 * GET /api/cron/verify-paytm-orders
 *
 * Re-checks every still-pending Paytm-routed order against Paytm's own
 * order-status API. This is the fix for Paytm orders that never got
 * verified because verification previously only ran when a customer's
 * own browser polled the checkout page (see getPublicOrderStatus in
 * developerController.js, and getLinkOrderStatus in
 * paymentLinkController.js, for that original trigger point) — if the
 * customer closed the tab, lost connection, or the page never finished
 * loading, the order stayed 'pending' forever even though Paytm had
 * genuinely received the payment. Running this on a schedule means a
 * pending Paytm order gets checked regardless of what the customer's
 * browser does after paying.
 *
 * Safe to run frequently and concurrently with a customer's own poll —
 * paytmService.verifyPayment() already contains its own idempotency
 * (the payments/{orderId} transaction only ever fires once), so this
 * cron and a live user poll racing on the same order just means
 * whichever gets there first wins; the other sees status !== 'pending'
 * and no-ops.
 */
router.get('/verify-paytm-orders', requireCronSecret, async (req, res) => {
  try {
    const pending = await firebaseService.getPendingPaytmOrders();
    logger.info(`[cron] verify-paytm-orders: checking ${pending.length} pending order(s)`);

    let verified = 0;
    let stillPending = 0;
    let errored = 0;

    // Sequential, not Promise.all — this hits Paytm's live API once per
    // order, and there's no urgency here (it's a periodic sweep, not a
    // user waiting on a response), so there's no reason to burst dozens
    // of concurrent requests at Paytm and risk rate-limiting the account
    // this MID belongs to.
    for (const order of pending) {
      try {
        const result = await paytmService.verifyPayment(order.orderId);
        if (result) verified++;
        else stillPending++;
      } catch (e) {
        errored++;
        logger.warn(`[cron] verify-paytm-orders: order ${order.orderId} failed: ${e.message}`);
      }
    }

    logger.info(`[cron] verify-paytm-orders done: ${verified} verified, ${stillPending} still pending, ${errored} errored`);

    // ─── FamPay late-reconciliation sweep, same cron run ───────────────
    // Folded into this SAME endpoint/invocation rather than a separate
    // route: Vercel's Hobby plan allows only 1 cron schedule, already
    // spent on this one (see vercel.json). See
    // firebaseService.getRecentlyCancelledFampayOrders and
    // fampayService.verifyPayment's LATE_RECONCILE_WINDOW_MS for the full
    // gap this closes — a payment that succeeds (e.g. via a gallery-scan
    // retry after an app-side failure) just after this order's checkout
    // timer expired and cancelOrder() had already marked it 'cancelled'/
    // 'timeout'. fampayService.verifyPayment already enforces its own
    // idempotency (status is re-checked against the same window on every
    // call) and the identical "not already claimed" UTR/txn-id dedup
    // used for normal pending orders, so running this is safe even if a
    // customer's own late page-poll or another cron overlap hits the
    // same order at the same time.
    let famVerified = 0, famStillUnmatched = 0, famErrored = 0;
    try {
      const recentlyCancelled = await firebaseService.getRecentlyCancelledFampayOrders();
      logger.info(`[cron] reconcile-fampay-late: checking ${recentlyCancelled.length} recently-cancelled order(s)`);
      for (const order of recentlyCancelled) {
        try {
          const result = await fampayService.verifyPayment(order.orderId);
          if (result) famVerified++;
          else famStillUnmatched++;
        } catch (e) {
          famErrored++;
          logger.warn(`[cron] reconcile-fampay-late: order ${order.orderId} failed: ${e.message}`);
        }
      }
      logger.info(`[cron] reconcile-fampay-late done: ${famVerified} reconciled, ${famStillUnmatched} still unmatched, ${famErrored} errored`);
    } catch (famErr) {
      logger.error('[cron] reconcile-fampay-late fatal error:', famErr.message);
    }

    // ─── Still-pending FamPay orders, same cron run ────────────────────
    // Closes the other half of the gap the late-reconcile sweep above
    // only partially covers: a FamPay order that's still 'pending' (not
    // yet 'cancelled'/'timeout') whose checkout tab stopped polling —
    // most commonly because the customer switched away to their UPI app
    // to actually pay, and the mobile browser throttled/paused that
    // backgrounded tab's JS timers while they were gone. Without this,
    // such an order only ever gets re-checked if/when the customer
    // reopens that same tab, which may never happen even though the
    // payment itself genuinely went through. See
    // firebaseService.getPendingFampayOrders for the exact window.
    // Same idempotency/dedup guarantees as the sweep above — safe to run
    // concurrently with a customer's own live poll.
    let famPendingVerified = 0, famPendingStillUnmatched = 0, famPendingErrored = 0;
    try {
      const stillPending = await firebaseService.getPendingFampayOrders();
      logger.info(`[cron] reconcile-fampay-pending: checking ${stillPending.length} still-pending order(s)`);
      for (const order of stillPending) {
        try {
          const result = await fampayService.verifyPayment(order.orderId);
          if (result) famPendingVerified++;
          else famPendingStillUnmatched++;
        } catch (e) {
          famPendingErrored++;
          logger.warn(`[cron] reconcile-fampay-pending: order ${order.orderId} failed: ${e.message}`);
        }
      }
      logger.info(`[cron] reconcile-fampay-pending done: ${famPendingVerified} verified, ${famPendingStillUnmatched} still unmatched, ${famPendingErrored} errored`);
    } catch (famPendingErr) {
      logger.error('[cron] reconcile-fampay-pending fatal error:', famPendingErr.message);
    }

    return res.json({
      success: true,
      paytm: { checked: pending.length, verified, stillPending, errored },
      fampayLateReconcile: { verified: famVerified, stillUnmatched: famStillUnmatched, errored: famErrored },
      fampayStillPending: { verified: famPendingVerified, stillUnmatched: famPendingStillUnmatched, errored: famPendingErrored },
    });
  } catch (err) {
    logger.error('[cron] verify-paytm-orders fatal error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
