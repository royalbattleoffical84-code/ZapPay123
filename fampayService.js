// services/fampayService.js
const firebaseService = require('./firebaseService');
const walletService = require('./walletService');
const webhookService = require('./webhookService');
const notificationService = require('./notificationService');
const encryption = require('../utils/encryption');
const logger = require('../utils/logger');
const { ref } = require('../firebase/admin');
const { DB_PATHS, VERIFICATION_METHOD } = require('../config/constants');
const { fetchFamPayHistory } = require('../controllers/historyController');

// FamPay's email text only ever states the time as "H:MM AM/PM" — never
// seconds (historyController.js's regex has no seconds group because
// the email genuinely doesn't include one). So a parsed txnTime is
// really the START of that minute, not an exact instant: the real
// payment could have happened anywhere in [txnTime, txnTime+59.999s].
// STRICT creation-time guard. A transaction can only pay this order if
// it happened at/after the order was created.
//  - txn.ts   = real epoch of the payment (FamPay states only the minute,
//               so the payment lies in [ts, ts+59.999s]); computed in IST
//               in historyController.js (NOT server-local time).
//  - txn.mailTs = the email's own Date header (second precision). An email
//               that arrived before the order existed can never be its payment.
// Missing/unparseable time => rejected (never assumed fresh).
const EMAIL_MINUTE_PRECISION_MS = 60 * 1000;
function isTxnAfterOrder(txn, orderCreatedAt) {
  if (!orderCreatedAt || !txn || typeof txn.ts !== 'number') return false;
  if (txn.ts + EMAIL_MINUTE_PRECISION_MS - 1 < orderCreatedAt) return false;
  if (typeof txn.mailTs === 'number' && txn.mailTs < orderCreatedAt) return false;
  return true;
}

// Previously an HTTP round-trip to https://YOUR-DOMAIN.com/history.php (a
// PHP script using the imap_* extension, which does not exist on
// Vercel's serverless runtime — see historyController.js for the full
// migration note). Now an in-process call — same parsing logic, one
// fewer network hop, and no dependency on that PHP file's continued
// existence at all.

// Hard ceiling on how late a payment can still be reconciled against a
// cancelled/timeout order — see the status guard below. Keeps a payment
// made minutes after checkout expired from being lost, without leaving
// every cancelled order checkable forever (a customer could otherwise
// pay a months-old, long-abandoned order and still have it go through).
const LATE_RECONCILE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────
// WHY MATCHING IS "LATEST EMAIL + AMOUNT + A SINGLE ONE-SIDED TIME
// GUARD" AND NOTHING FANCIER
// ─────────────────────────────────────────────────────────────────────
// Earlier versions compared a transaction's email timestamp against the
// order's creation timestamp on BOTH sides (too-early AND too-late),
// with various buffers for clock skew and FamPay's emails only stating
// whole minutes, never seconds. That kept producing false rejections
// for genuinely successful payments.
//
// The very next version went too far the other way and dropped time
// entirely — which then let a stale, already-sitting-in-the-inbox email
// (very easy to end up with: this account alone has many separate ₹1
// test transactions from testing this exact feature) wrongly verify a
// brand-new, unrelated order of the same amount, including ones from
// BEFORE the order even existed. Not acceptable.
//
// This version keeps the useful part of each — the single-latest-email
// simplicity, AND a time check — but only enforces the direction that
// actually matters for correctness: an email from before this order was
// created can NEVER be what paid for it, full stop. There's no matching
// upper-bound check here (a payment arriving late within the order's
// own lifetime is still fine; LATE_RECONCILE_WINDOW_MS below also
// already bounds how long any of this keeps running at all), so this
// doesn't reintroduce the false-rejection problem from the first
// version — it only closes the specific "verified against an email that
// predates the order" hole.
//
//   - getPublicOrderStatus (developerController.js) now re-triggers this
//     check at most every 5 seconds while an order is pending/ambiguous
//     — in effect, the mailbox is "live-synced" every 5s for the
//     duration of the order, same idea as the merchant's own "Live
//     Email History" sync on the FamPay Connect page, just running
//     silently in the background for this one order instead of being a
//     manual button.
//   - Only the NEWEST email FamPay has sent (historyController.js
//     already returns transactions newest-first) is ever considered a
//     candidate — not a backlog of the last 15. This is what keeps
//     "amount-only, no time check" safe: an old, unrelated, same-amount
//     transaction sitting further back in the inbox is never looked at,
//     only whatever just arrived.
//   - The order's own lifetime (3 or 8 minutes, set by Admin Settings'
//     "Amount + Time Verification Mode" — see checkoutUrlBuilder.js) is
//     still what bounds how long this checking happens at all: once the
//     checkout page's countdown ends, cancelOrder() marks the order
//     'cancelled'/'timeout' and this function stops being called for it
//     (barring the LATE_RECONCILE_WINDOW_MS grace below).
//   - Reuse protection (an identifier already claimed by a different
//     order) and the ambiguous-match guard (more than one open order of
//     the same amount for the same mailbox right now) are UNCHANGED —
//     removing time checks doesn't touch either of those.
const verifyPayment = async (orderId) => {
  const startedAt = Date.now();
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    // Real-world gap this closes: a customer's UPI app fails on first
    // attempt (e.g. a "₹2,000 gallery-scan limit" popup from the UPI app
    // itself — a client-side app restriction, not a ZapPay bug), they
    // retry by a different method (QR download → gallery scan), and that
    // retry succeeds — but takes long enough that this order's checkout
    // timer already expired and cancelOrder() (developerController.js)
    // had already marked it 'cancelled'/'timeout'. The money is real and
    // already sitting in the merchant's FamPay account; without this,
    // nothing ever checks this order again and that payment is silently
    // orphaned. A cancelled/timeout order is only reconsidered within
    // LATE_RECONCILE_WINDOW_MS of when it was last updated (i.e. when it
    // was cancelled) — a genuinely abandoned order from hours/days ago
    // stays cancelled.
    const isLateReconcile = payment.status === 'cancelled' || payment.status === 'timeout';
    // 'ambiguous' orders stay re-checkable exactly like 'pending': a
    // sibling order that was blocking a deterministic match may have
    // resolved since the last poll (paid, cancelled, or manually
    // UTR-verified), which can turn yesterday's "can't tell which
    // order" into "only one candidate left now".
    const isRecheckable = payment.status === 'pending' || payment.status === 'ambiguous';
    if (!isRecheckable && !isLateReconcile) return false;
    if (isLateReconcile) {
      const cancelledAt = typeof payment.updatedAt === 'number' ? payment.updatedAt : Date.parse(payment.updatedAt) || 0;
      if (Date.now() - cancelledAt > LATE_RECONCILE_WINDOW_MS) return false;
    }

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const [user, settings] = await Promise.all([firebaseService.getUser(verifyUid), firebaseService.getSettings()]);
    if (!user || !user.fampay || !user.fampay.isConnected) return false;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return false;

    // Still read here purely to label which method produced a match
    // (AUTO_PURPOSE vs AUTO_AMOUNT_TIME) for the Admin Panel's
    // Verification Log — it no longer changes any matching behavior
    // itself (see the big comment block above this function).
    const amountTimeMode = !!settings.amountTimeVerificationMode;
    const verificationMode = amountTimeMode ? 'AMOUNT_TIME' : 'NORMAL';

    const createdAtMs = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const historyResult = await fetchFamPayHistory(user.fampay.email, rawPassword, 5, { sinceMs: createdAtMs });

    // historyController's fetchFamPayHistory() keeps the exact same
    // field name history.php used ("status", not "success") — this
    // check always rejected a genuinely successful response before
    // ever reaching the match below.
    if (!historyResult || !historyResult.status) return false;

    const transactions = historyResult.data || [];
    if (transactions.length === 0) return false;

    // Newest-first list. Pick the newest transaction that has the same
    // amount AND happened at/after this order's creation. Anything older
    // than the order is ignored completely.
    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const latest = transactions.find((t) => parseFloat(t.amount) === paymentAmount && isTxnAfterOrder(t, orderCreatedAt));
    if (!latest) return false;
    const txnAmount = parseFloat(latest.amount);

    // Normal Mode only, kept exactly as before: FamX often echoes its
    // own "ZP<orderId>"-style reference in the payment note. Not
    // required (FamPay-to-FamPay transfers frequently have no purpose
    // text at all) — but if purpose IS present and does NOT contain
    // this order's id, that's a strong sign the email belongs to a
    // different order, so it's rejected rather than trusted on amount
    // alone. Amount+Time Mode never looks at purpose at all.
    let verificationMethod = VERIFICATION_METHOD.AUTO_AMOUNT_TIME;
    if (!amountTimeMode) {
      if (latest.purpose && latest.purpose !== 'NA' && !latest.purpose.includes(orderId)) return false;
      verificationMethod = (latest.purpose && latest.purpose !== 'NA')
        ? VERIFICATION_METHOD.AUTO_PURPOSE
        : VERIFICATION_METHOD.AUTO_AMOUNT_TIME;
    }

    const txnIdentifier = (latest.utr && latest.utr !== 'NA') ? latest.utr : latest.txn_id;
    if (txnIdentifier && txnIdentifier !== 'NA') {
      const existingCheck = await firebaseService.getPaymentByUtr(txnIdentifier);
      if (existingCheck && existingCheck.orderId !== orderId) {
        // This exact email has already been claimed by a different
        // order — never let the same payment confirm two orders.
        return false;
      }
    }

    // ── Ambiguous-match guard ──────────────────────────────────────
    // Without a time window to narrow things down, two still-open
    // orders of the same amount for the same mailbox would otherwise
    // both look like valid matches for this one email. Rather than
    // guess, every other currently pending/ambiguous order for this
    // mailbox is counted; if more than this one shares the amount,
    // leave it AMBIGUOUS instead of auto-verifying either — manual UTR
    // entry stays available to resolve it deterministically.
    const siblingsSnap = await ref(DB_PATHS.PAYMENTS)
      .orderByChild('fampayVerifyUid')
      .equalTo(verifyUid)
      .once('value');
    let candidateCount = 0;
    if (siblingsSnap.exists()) {
      siblingsSnap.forEach((child) => {
        const o = child.val();
        if ((o.status === 'pending' || o.status === 'ambiguous') && parseFloat(o.amount) === txnAmount) {
          candidateCount++;
        }
      });
    }
    if (candidateCount > 1) {
      if (payment.status !== 'ambiguous') {
        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ status: 'ambiguous', updatedAt: Date.now() });
      }
      await firebaseService.logVerificationAttempt({
        orderId,
        amount: txnAmount,
        paymentTime: latest.datetime,
        utrMasked: firebaseService.maskIdentifier(txnIdentifier),
        verificationMethod: VERIFICATION_METHOD.AUTO_AMOUNT_TIME,
        verificationMode,
        result: 'AMBIGUOUS',
        reason: 'Multiple currently-open orders share this amount for the same mailbox',
        processingTimeMs: Date.now() - startedAt,
      });
      return false;
    }

    // Sender name as FamPay's own email stated it (historyController.js's
    // `name` field, parsed from "... received ₹X from <Name> at ...").
    // Surfaced on the checkout page's success popup so it's clear who the
    // money actually came from. Never guessed/defaulted — left out
    // entirely when the email didn't have a usable name.
    const payerName = (latest.name && latest.name !== 'NA') ? latest.name : null;

    logger.info(`FamPay Match Found for Order ${orderId}! UTR: ${latest.utr}${isLateReconcile ? ' (late reconciliation — order was ' + payment.status + ')' : ''}`);

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: 'success',
      utr: latest.utr,
      txnId: latest.txn_id || latest.utr,
      payerName,
      updatedAt: Date.now()
    });

    // ─── Wallet credit (routing-dependent) ────────────────────────
    // Three routingEngine values reach this function: 'system_cashier',
    // 'cashier', and 'wallet' (see paymentLinkController/paymentController/
    // storeController/developerController/subscriptionController for
    // where each is set).
    //
    // - system_cashier: ZapPay's own pooled FamPay collects the money —
    //   it genuinely passes through ZapPay, so it must be credited to
    //   the merchant's Zap Cash wallet (capped at walletLimit).
    // - wallet: same — money genuinely lands in a ZapPay-controlled
    //   account, so it's credited the same way.
    // - cashier: the merchant's OWN connected FamPay account collects
    //   the money directly — it's already sitting in their own FamPay/
    //   bank, never touching ZapPay. Crediting Zap Cash here would be a
    //   real duplicate: the merchant would have the money in their own
    //   account AND a matching ZapPay wallet balance they could then
    //   withdraw — a double-payout. So 'cashier' must NEVER credit
    //   Zap Cash; only the Zap Credit commission below applies, and
    //   incrementPaymentLinkStats (for the Paid-count/collected total)
    //   still runs regardless, since that's just a record, not money
    //   movement.
    const subscriptionService = require('./subscriptionService');
    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${payment.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };

    if (payment.routingEngine === 'cashier') {
      logger.info(`Order ${orderId}: genuine cashier routing — money already in merchant's own FamPay, skipping Zap Cash credit.`);
    } else {
      try {
        const balance = await walletService.getBalance(payment.userId);
        const available = plan.walletLimit - balance;

        const credit = Math.min(txnAmount, available);
        if (credit > 0) {
          await walletService.creditWallet(payment.userId, credit, `Order ${orderId}`);
        }
      } catch (e) {
        logger.error(`Error crediting wallet for ${payment.routingEngine}: ${e.message}`);
      }
    }

    // ─── Zap Credit deduction (unconditional) ─────────────────────
    // Commission is owed on every successful order regardless of
    // routing engine — cashier or direct wallet, doesn't matter.
    // Never blocks the payment itself: a failed debit here (e.g.
    // insufficient Zap Credit) is logged, not thrown, since the
    // customer has already paid and the merchant's wallet is
    // already credited by this point.
    const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((txnAmount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for order ${orderId}: ${e.message}`);
      }
    }

    webhookService.notifyUserWebhooks(payment.userId, 'order.success', {
      order_id: orderId,
      status: 'success',
      amount: txnAmount,
      utr: latest.utr,
      payer_name: payerName,
    }).catch(() => {});

    if (payment.linkId) {
      await firebaseService.incrementPaymentLinkStats(payment.linkId, txnAmount);
    }

    let title = isLateReconcile ? '💰 Late Payment Reconciled' : '💰 Payment Received via FamPay';
    let message = isLateReconcile
      ? `₹${txnAmount} arrived after checkout had expired and was still matched to Order: ${orderId}. Wallet credited normally.`
      : `₹${txnAmount} received${payerName ? ' from ' + payerName : ''} in your FamPay account. Order: ${orderId}`;
    if (payment.storeId && payment.productId) {
      try {
        const productSnap = await ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`).once('value');
        const productData = productSnap.val();
        if (productData) {
          title = '🛍️ Product Sold!';
          message = `"${productData.title || 'Product'}" sold for ₹${txnAmount} via FamPay. Order: ${orderId}`;
          await ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`).update({
            salesCount: (productData.salesCount || 0) + 1,
            totalCollected: (productData.totalCollected || 0) + txnAmount,
            lastSoldAt: Date.now(),
          });
        }
      } catch (e) {
        logger.warn(`Product stats update failed for ${orderId}: ${e.message}`);
      }
    } else if (payment.linkId) {
      title = '💰 Payment Received via Link';
      message = `₹${txnAmount} received${payerName ? ' from ' + payerName : ''} via your payment link (FamPay). Order: ${orderId}`;
    }

    await notificationService.createNotification(payment.userId, {
      title, message, type: 'payment',
    });

    await firebaseService.logVerificationAttempt({
      orderId,
      amount: txnAmount,
      paymentTime: latest.datetime,
      utrMasked: firebaseService.maskIdentifier(txnIdentifier),
      verificationMethod,
      verificationMode,
      result: 'VERIFIED',
      reason: verificationMethod === VERIFICATION_METHOD.AUTO_PURPOSE
        ? 'Amount matched the latest mailbox email and Note/Purpose corroborated it'
        : 'Amount matched the latest mailbox email',
      processingTimeMs: Date.now() - startedAt,
    });

    return true;
  } catch (err) {
    logger.error(`Fampay verification error for ${orderId}: ${err.message}`);
    return false;
  }
};

async function checkUtrForOrder(orderId, identifier) {
  const startedAt = Date.now();
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.fampay || !user.fampay.isConnected) return false;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return false;

    const settings = await firebaseService.getSettings();
    const verificationMode = settings.amountTimeVerificationMode ? 'AMOUNT_TIME' : 'NORMAL';

    const historyResult = await fetchFamPayHistory(user.fampay.email, rawPassword, 20);
    // Same field-name contract as verifyPayment above — historyResult
    // uses "status", not "success".
    if (!historyResult || !historyResult.status) return false;

    const transactions = historyResult.data || [];
    const paymentAmount = parseFloat(payment.amount);
    const identifierTrimmed = identifier.trim();

    // Manual entry: the user typed a SPECIFIC identifier, which is
    // already a strong, precise signal on its own — unlike the
    // amount-only auto-check above, there's no "which transaction is
    // this" ambiguity to resolve, so the full recently-fetched batch is
    // searched (not just the latest email) and no time window is
    // applied at all.
    for (const txn of transactions) {
      const txnAmount = parseFloat(txn.amount);
      const utrMatch = (txn.utr === identifierTrimmed);
      const txnIdMatch = (txn.txn_id === identifierTrimmed);

      if ((utrMatch || txnIdMatch) && txnAmount === paymentAmount) {
        if (txn.utr && txn.utr !== 'NA') {
          const existingUtrCheck = await firebaseService.getPaymentByUtr(txn.utr);
          if (existingUtrCheck && existingUtrCheck.orderId !== orderId) continue;
        }
        if (txn.txn_id && txn.txn_id !== 'NA') {
          const existingTxnCheck = await firebaseService.getPaymentByTxnId(txn.txn_id);
          if (existingTxnCheck && existingTxnCheck.orderId !== orderId) continue;
        }

        const payerName = (txn.name && txn.name !== 'NA') ? txn.name : null;
        if (payerName) {
          await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ payerName });
        }

        await firebaseService.logVerificationAttempt({
          orderId,
          amount: txnAmount,
          paymentTime: txn.datetime,
          utrMasked: firebaseService.maskIdentifier(identifierTrimmed),
          verificationMethod: VERIFICATION_METHOD.MANUAL_UTR,
          verificationMode,
          result: 'VERIFIED',
          reason: 'User-submitted UTR/Txn ID matched a mailbox record',
          processingTimeMs: Date.now() - startedAt,
        });

        return true;
      }
    }
    return false;
  } catch (err) {
    logger.error(`checkUtrForOrder error for ${orderId}: ${err.message}`);
    return false;
  }
}

/**
 * Non-mutating "what does the mailbox say right now" peek, for the
 * checkout page's manual "Refresh if payment not verified" button.
 * Deliberately returns something ONLY when the mailbox's single latest
 * email's amount equals THIS order's amount ("same amount compulsory",
 * exactly as verifyPayment itself requires to actually verify) — never
 * an unrelated amount from some other transaction, so a customer
 * clicking Refresh on their own checkout page can never see a glimpse
 * of a completely different payment that has nothing to do with their
 * order. Never changes order status, credits a wallet, or marks
 * anything as used — verifyPayment (already called first by the
 * controller before this) is what actually verifies; this only answers
 * "is there something matching sitting there, in case auto-verify
 * hasn't caught up yet".
 */
async function peekLatestTransaction(orderId) {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return null;

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.fampay || !user.fampay.isConnected) return null;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return null;

    const historyResult = await fetchFamPayHistory(user.fampay.email, rawPassword, 5, { sinceMs: typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0 });
    if (!historyResult || !historyResult.status) return null;

    const transactions = historyResult.data || [];
    if (transactions.length === 0) return null;

    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const latest = transactions.find((t) => parseFloat(t.amount) === paymentAmount && isTxnAfterOrder(t, orderCreatedAt));
    if (!latest) return null;
    const txnAmount = parseFloat(latest.amount);

    return {
      amount: txnAmount,
      payerName: (latest.name && latest.name !== 'NA') ? latest.name : null,
    };
  } catch (err) {
    logger.error(`peekLatestTransaction error for ${orderId}: ${err.message}`);
    return null;
  }
}

module.exports = { verifyPayment, checkUtrForOrder, peekLatestTransaction };
