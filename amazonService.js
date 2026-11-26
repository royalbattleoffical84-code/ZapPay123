// services/amazonService.js
//
// Amazon Pay Wallet cashier verification — the counterpart of
// fampayService.js. A merchant connects their own Gmail (App Password);
// when a customer pays the merchant's Amazon Pay UPI ID, Amazon emails
// "You have added ₹X successfully to your Amazon Pay Wallet" with a UPI
// Reference ID. This file matches that email to a pending order.
//
// Matching rules (strict on purpose):
//   1. Amount must equal the order amount exactly.
//   2. The email must have ARRIVED AFTER the order was created. The email
//      has only an "Order Date" (no time of day), so its own Date header is
//      used — exact to the second, no minute-rounding grace. An email that
//      predates the order can never be its payment.
//   3. The UPI Reference ID must not already be claimed by another order.
//   4. If more than one open Amazon order of the same amount exists for
//      this merchant, the order is left 'ambiguous' (manual UTR resolves).
const firebaseService = require('./firebaseService');
const walletService = require('./walletService');
const webhookService = require('./webhookService');
const notificationService = require('./notificationService');
const encryption = require('../utils/encryption');
const logger = require('../utils/logger');
const { ref } = require('../firebase/admin');
const { DB_PATHS, VERIFICATION_METHOD } = require('../config/constants');
const { fetchAmazonHistory } = require('../controllers/historyController');

// A cancelled/timeout order is still re-checkable for this long (a
// payment made right as checkout expired shouldn't be orphaned).
const LATE_RECONCILE_WINDOW_MS = 30 * 60 * 1000;

function toMs(v) {
  return typeof v === 'number' ? v : (Date.parse(v) || 0);
}

// Strict creation-time guard (see header). tsPrecisionMs is 0 for Amazon.
function isTxnAfterOrder(txn, orderCreatedAt) {
  if (!orderCreatedAt || !txn || typeof txn.ts !== 'number') return false;
  const precision = typeof txn.tsPrecisionMs === 'number' ? txn.tsPrecisionMs : 0;
  if (txn.ts + precision <= orderCreatedAt) return false;
  if (typeof txn.mailTs === 'number' && txn.mailTs <= orderCreatedAt) return false;
  return true;
}

async function loadMailbox(payment) {
  const user = await firebaseService.getUser(payment.userId);
  if (!user || !user.amazon || !user.amazon.isConnected) return null;
  const rawPassword = encryption.decrypt(user.amazon.password);
  if (!rawPassword) return null;
  return { user, email: user.amazon.email, rawPassword };
}

const verifyPayment = async (orderId) => {
  const startedAt = Date.now();
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    const isLateReconcile = payment.status === 'cancelled' || payment.status === 'timeout';
    const isRecheckable = payment.status === 'pending' || payment.status === 'ambiguous';
    if (!isRecheckable && !isLateReconcile) return false;
    if (isLateReconcile && Date.now() - toMs(payment.updatedAt) > LATE_RECONCILE_WINDOW_MS) return false;

    const verifyUid = payment.userId;
    const [mailbox, settings] = await Promise.all([loadMailbox(payment), firebaseService.getSettings()]);
    if (!mailbox) return false;

    const verificationMode = settings.amountTimeVerificationMode ? 'AMOUNT_TIME' : 'NORMAL';
    const createdAtMs = toMs(payment.createdAt);
    const paymentAmount = parseFloat(payment.amount);

    const historyResult = await fetchAmazonHistory(mailbox.email, mailbox.rawPassword, 8, { sinceMs: createdAtMs });
    if (!historyResult || !historyResult.status) return false;
    const transactions = historyResult.data || [];
    if (transactions.length === 0) return false;

    // Newest-first: first email with the same amount, that arrived after
    // this order existed, and whose UPI Reference ID no other order owns.
    let latest = null;
    for (const t of transactions) {
      if (parseFloat(t.amount) !== paymentAmount || !isTxnAfterOrder(t, createdAtMs)) continue;
      const claimed = await firebaseService.getPaymentByUtr(t.utr);
      if (claimed && claimed.orderId !== orderId) continue;
      latest = t;
      break;
    }
    if (!latest) return false;

    const txnAmount = parseFloat(latest.amount);
    const txnIdentifier = latest.utr;

    // Ambiguous-match guard: bounded to this merchant's most recent orders.
    const sibSnap = await ref(DB_PATHS.PAYMENTS).orderByChild('userId').equalTo(verifyUid).limitToLast(60).once('value');
    let candidateCount = 0;
    if (sibSnap.exists()) {
      sibSnap.forEach((child) => {
        const o = child.val();
        if (o.paymentMethod === 'amazon' && (o.status === 'pending' || o.status === 'ambiguous') && parseFloat(o.amount) === txnAmount) {
          candidateCount++;
        }
      });
    }
    if (candidateCount > 1) {
      if (payment.status !== 'ambiguous') {
        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ status: 'ambiguous', updatedAt: Date.now() });
      }
      await firebaseService.logVerificationAttempt({
        orderId, amount: txnAmount, paymentTime: latest.datetime,
        utrMasked: firebaseService.maskIdentifier(txnIdentifier),
        verificationMethod: VERIFICATION_METHOD.AUTO_AMOUNT_TIME, verificationMode,
        result: 'AMBIGUOUS',
        reason: 'Multiple currently-open Amazon Pay orders share this amount for the same mailbox',
        processingTimeMs: Date.now() - startedAt,
      });
      return false;
    }

    logger.info(`Amazon Pay Match Found for Order ${orderId}! UTR: ${latest.utr}${isLateReconcile ? ' (late reconciliation — order was ' + payment.status + ')' : ''}`);

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: 'success',
      utr: latest.utr,
      txnId: latest.txn_id || latest.utr,
      payerName: null, // Amazon's wallet-credit email never names the payer
      updatedAt: Date.now(),
    });

    // 'amazon_cashier' = the merchant's OWN Amazon Pay wallet collected
    // the money directly; it never passes through ZapPay, so Zap Cash must
    // NOT be credited (that would double-pay the merchant). Only the Zap
    // Credit commission below applies. Any other engine reaching this
    // function credits the wallet like fampayService does.
    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${payment.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };

    if (payment.routingEngine === 'amazon_cashier') {
      logger.info(`Order ${orderId}: Amazon cashier routing — money already in merchant's own Amazon Pay, skipping Zap Cash credit.`);
    } else {
      try {
        const balance = await walletService.getBalance(payment.userId);
        const credit = Math.min(txnAmount, plan.walletLimit - balance);
        if (credit > 0) await walletService.creditWallet(payment.userId, credit, `Order ${orderId}`);
      } catch (e) {
        logger.error(`Error crediting wallet for ${payment.routingEngine}: ${e.message}`);
      }
    }

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
      order_id: orderId, status: 'success', amount: txnAmount, utr: latest.utr, payer_name: null,
    }).catch(() => {});

    if (payment.linkId) await firebaseService.incrementPaymentLinkStats(payment.linkId, txnAmount);

    let title = isLateReconcile ? '💰 Late Payment Reconciled' : '💰 Payment Received via Amazon Pay';
    let message = isLateReconcile
      ? `₹${txnAmount} arrived after checkout had expired and was still matched to Order: ${orderId}.`
      : `₹${txnAmount} received in your Amazon Pay wallet. Order: ${orderId}`;
    if (payment.storeId && payment.productId) {
      try {
        const productSnap = await ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`).once('value');
        const productData = productSnap.val();
        if (productData) {
          title = '🛍️ Product Sold!';
          message = `"${productData.title || 'Product'}" sold for ₹${txnAmount} via Amazon Pay. Order: ${orderId}`;
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
      message = `₹${txnAmount} received via your payment link (Amazon Pay). Order: ${orderId}`;
    }

    await notificationService.createNotification(payment.userId, { title, message, type: 'payment' });

    await firebaseService.logVerificationAttempt({
      orderId, amount: txnAmount, paymentTime: latest.datetime,
      utrMasked: firebaseService.maskIdentifier(txnIdentifier),
      verificationMethod: VERIFICATION_METHOD.AUTO_AMOUNT_TIME, verificationMode,
      result: 'VERIFIED',
      reason: 'Amount matched an Amazon Pay wallet-credit email that arrived after the order was created',
      processingTimeMs: Date.now() - startedAt,
    });

    return true;
  } catch (err) {
    logger.error(`Amazon Pay verification error for ${orderId}: ${err.message}`);
    return false;
  }
};

// Manual "I paid, here's my UPI Reference ID" check.
async function checkUtrForOrder(orderId, identifier) {
  const startedAt = Date.now();
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    const [mailbox, settings] = await Promise.all([loadMailbox(payment), firebaseService.getSettings()]);
    if (!mailbox) return false;
    const verificationMode = settings.amountTimeVerificationMode ? 'AMOUNT_TIME' : 'NORMAL';

    const historyResult = await fetchAmazonHistory(mailbox.email, mailbox.rawPassword, 20, { sinceMs: toMs(payment.createdAt) });
    if (!historyResult || !historyResult.status) return false;

    const paymentAmount = parseFloat(payment.amount);
    const wanted = String(identifier || '').trim();
    const createdAtMs = toMs(payment.createdAt);

    for (const txn of historyResult.data || []) {
      if (txn.utr !== wanted || parseFloat(txn.amount) !== paymentAmount) continue;
      // Even a typed UTR can't claim an email that predates the order.
      if (!isTxnAfterOrder(txn, createdAtMs)) continue;
      const claimed = await firebaseService.getPaymentByUtr(txn.utr);
      if (claimed && claimed.orderId !== orderId) continue;

      await firebaseService.logVerificationAttempt({
        orderId, amount: paymentAmount, paymentTime: txn.datetime,
        utrMasked: firebaseService.maskIdentifier(wanted),
        verificationMethod: VERIFICATION_METHOD.MANUAL_UTR, verificationMode,
        result: 'VERIFIED',
        reason: 'User-submitted UPI Reference ID matched an Amazon Pay mailbox record',
        processingTimeMs: Date.now() - startedAt,
      });
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`Amazon checkUtrForOrder error for ${orderId}: ${err.message}`);
    return false;
  }
}

// Non-mutating peek for the checkout page's "Refresh" button — only ever
// returns something for THIS order's exact amount.
async function peekLatestTransaction(orderId) {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return null;
    const mailbox = await loadMailbox(payment);
    if (!mailbox) return null;

    const createdAtMs = toMs(payment.createdAt);
    const historyResult = await fetchAmazonHistory(mailbox.email, mailbox.rawPassword, 8, { sinceMs: createdAtMs });
    if (!historyResult || !historyResult.status) return null;

    const paymentAmount = parseFloat(payment.amount);
    const latest = (historyResult.data || []).find((t) => parseFloat(t.amount) === paymentAmount && isTxnAfterOrder(t, createdAtMs));
    if (!latest) return null;
    return { amount: parseFloat(latest.amount), payerName: null };
  } catch (err) {
    logger.error(`Amazon peekLatestTransaction error for ${orderId}: ${err.message}`);
    return null;
  }
}

module.exports = { verifyPayment, checkUtrForOrder, peekLatestTransaction };
