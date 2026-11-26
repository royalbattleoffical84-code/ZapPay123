// controllers/developerController.js - ZapAPI Developer Platform
const { body, validationResult } = require('express-validator');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const zapService = require('../services/zapService');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const subscriptionService = require('../services/subscriptionService');
const apiTokenService = require('../services/apiTokenService');
const gatewayModeService = require('../services/gatewayModeService');
const webhookService = require('../services/webhookService');
const response = require('../helpers/response');
const logger = require('../utils/logger');
const { buildCheckoutUrl } = require('../utils/checkoutUrlBuilder');

const getMyToken = async (req, res) => {
  try {
    const record = await apiTokenService.getOrCreateToken(req.user.uid);
    const mode = await gatewayModeService.getMode(req.user.uid);
    const user = await firebaseService.getUser(req.user.uid); 
    const cashierConnected = !!(user?.fampay?.isConnected);
    const paytmCashierConnected = !!(user?.paytm?.isConnected);
    const amazonCashierConnected = !!(user?.amazon?.isConnected);
    // If Cashier/Paytm Cashier was previously selected but that gateway
    // has since been disconnected, don't report a routing engine the
    // merchant can no longer actually use.
    let reportedRoutingEngine = user?.apiRoutingEngine || 'wallet';
    if (reportedRoutingEngine === 'cashier' && !cashierConnected) reportedRoutingEngine = 'wallet';
    if (reportedRoutingEngine === 'paytm_cashier' && !paytmCashierConnected) reportedRoutingEngine = 'wallet';
    if (reportedRoutingEngine === 'amazon_cashier' && !amazonCashierConnected) reportedRoutingEngine = 'wallet';
    return response.success(res, 'ZapAPI key fetched', {
      apiKey: record.key,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt || null,
      mode,
      routingEngine: reportedRoutingEngine,
      cashierConnected,
      paytmCashierConnected,
      amazonCashierConnected,
    });
  } catch (err) {
    logger.error('Get ZapAPI token error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getMode = async (req, res) => {
  try {
    const mode = await gatewayModeService.getMode(req.user.uid);
    return response.success(res, 'Gateway mode fetched', { mode });
  } catch (err) {
    logger.error('Get gateway mode error:', err.message);
    return response.serverError(res, err.message);
  }
};

const setMode = async (req, res) => {
  try {
    const { mode } = req.body;
    if (mode !== 'live' && mode !== 'test') {
      return response.error(res, "Mode must be 'live' or 'test'");
    }
    await gatewayModeService.setMode(req.user.uid, mode);
    await firebaseService.logActivity(req.user.uid, 'gateway_mode_changed', { mode });
    return response.success(res, `Gateway switched to ${mode === 'test' ? 'Test' : 'Live'} Mode`, { mode });
  } catch (err) {
    logger.error('Set gateway mode error:', err.message);
    return response.serverError(res, err.message);
  }
};

const setRoutingEngine = async (req, res) => {
  try {
    const { routingEngine } = req.body;
    if (!['wallet', 'cashier', 'paytm_cashier', 'amazon_cashier'].includes(routingEngine)) return response.error(res, 'Invalid engine');

    // Cashier/Paytm Cashier routing only makes sense once that gateway is
    // actually connected — otherwise there's no UPI ID to build the
    // direct-QR checkout with, and every payment would silently fail.
    // Block the switch at the source instead of letting the frontend be
    // the only thing enforcing this.
    if (routingEngine === 'cashier') {
      const user = await firebaseService.getUser(req.user.uid);
      if (!user?.fampay?.isConnected) {
        return response.error(res, 'Connect FamPay first before switching to Cashier routing.');
      }
    }
    if (routingEngine === 'paytm_cashier') {
      const user = await firebaseService.getUser(req.user.uid);
      if (!user?.paytm?.isConnected) {
        return response.error(res, 'Connect Paytm first before switching to Paytm Cashier routing.');
      }
    }

    if (routingEngine === 'amazon_cashier') {
      const user = await firebaseService.getUser(req.user.uid);
      if (!user?.amazon?.isConnected) {
        return response.error(res, 'Connect Amazon Pay first before switching to Amazon Pay Cashier routing.');
      }
    }

    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: routingEngine });
    return response.success(res, 'Routing updated', { routingEngine });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const regenerateMyToken = async (req, res) => {
  try {
    const record = await apiTokenService.regenerateToken(req.user.uid);
    await firebaseService.logActivity(req.user.uid, 'zapapi_key_regenerated', {});
    return response.success(res, 'ZapAPI key regenerated', {
      apiKey: record.key,
      createdAt: record.createdAt,
    });
  } catch (err) {
    logger.error('Regenerate ZapAPI token error:', err.message);
    return response.serverError(res, err.message);
  }
};


// ─────────────────────────────────────────────────────────────────────
// SDK support: builds the raw UPI deep-link string for a given order so
// a merchant's OWN checkout UI (via the ZapPay Checkout SDK) can render
// its own QR code, instead of being handed a pre-built checkout page
// URL to redirect/iframe to. Exactly the same string check.html itself
// builds client-side (see Frontend_root_folder/check.html's QR BUILD
// section) — kept in one place so both stay in sync.
function buildUpiDeepLink(upiId, amount, orderId, payeeName) {
  if (!upiId) return null;
  const fmtAmt = Number(amount).toFixed(2);
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName || 'ZapPay Merchant',
    cu: 'INR',
    am: fmtAmt,
    tn: 'ZPP' + orderId,
  });
  return 'upi://pay?' + params.toString();
}

const createOrderValidation = [
  body('amount').notEmpty().withMessage('Amount is required').isFloat({ min: 1, max: 5000 }).withMessage('Amount must be between ₹1 and ₹5,000'),
  body('title').optional({ checkFalsy: true }).isLength({ max: 100 }).withMessage('Title must be under 100 characters').trim(),
  body('customer_mobile').optional({ checkFalsy: true }).isMobilePhone('en-IN').withMessage('Invalid mobile number'),
];

const createOrder = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const userId = req.user.uid;
    const { amount, title, customer_mobile, redirect_url, useEmbedded, routingEngine } = req.body;
    const amt = parseFloat(amount);
    const orderId = zapService.generateOrderId(userId);
    const remark = title || 'ZapPay Payment';

    const gatewayMode = await gatewayModeService.getMode(userId);

    // TEST MODE
    if (gatewayMode === 'test') {
      await firebaseService.createPayment(orderId, {
        userId, amount: amt, remark, customerMobile: customer_mobile || '',
        type: 'api', isTest: true, testRedirectUrl: redirect_url || null, testUseEmbedded: !!useEmbedded,
      });
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'test' }).catch((e) => {});

      // The customer lands on the SAME checkout page the merchant picked
      // on the Customize Page (Zenith / Aurora X / Prism) — not a separate
      // test.html — with &test_mode=1 so that page shows its own floating
      // test button (bottom-right) for simulating Success / Failed /
      // Cancelled. UPI id is a clearly-fake placeholder: the QR and app
      // buttons still render so the page looks real, but there's no real
      // account behind it for money to ever reach.
      const merchantForTest = await firebaseService.getUser(userId);
      const testModeSettings = await firebaseService.getSettings();
      const testCheckoutUrl = buildCheckoutUrl(merchantForTest, {
        orderId, amount: amt, upiId: 'test@zappay', redirectUrl: redirect_url || '', testMode: true,
        timeoutSec: testModeSettings.amountTimeVerificationMode ? 180 : 480,
      });
      return response.success(res, 'Order created (Test Mode)', {
        order_id: orderId, payment_url: testCheckoutUrl, amount: amt, mode: 'test',
        upi_id: 'test@zappay', qr_string: buildUpiDeepLink('test@zappay', amt, orderId, merchantForTest?.merchantDisplayName),
      });
    }

    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) return response.error(res, 'Payment system is under maintenance.', 503);
    // Drives the checkout page's countdown timer — see
    // utils/checkoutUrlBuilder.js and config/constants.js's
    // VERIFICATION_TIMEOUT_MS for the matching server-side window.
    const checkoutTimeoutSec = settings.amountTimeVerificationMode ? 180 : 480;

    const sub = await subscriptionService.getUserSubscription(userId);
    const balance = await walletService.getBalance(userId);
    if (balance + amt > sub.plan.walletLimit) {
      return response.error(res, 'Your ZapPay wallet is full. Upgrade your plan or withdraw first.');
    }

    // ─── Zap Credit gate ─────────────────────────────────────────
    const commissionPercent = sub.plan.commissionPercent ?? 5;
    const creditCheck = await walletService.checkSufficientCreditForOrder(userId, amt, commissionPercent);
    if (!creditCheck.ok) {
      logger.warn(`Insufficient Zap Credit for ZapAPI order: user=${userId} required=${creditCheck.required} available=${creditCheck.available}`);
      return response.error(res, 'Insufficient Zap Credit. Please recharge Zap Credit before accepting this payment.');
    }

    const merchantUser = await firebaseService.getUser(userId);
    // Routing is an account-wide setting controlled only from the Developer
    // Portal (apiRoutingEngine) — never a per-request choice, and never
    // honored as 'cashier'/'paytm_cashier' unless that gateway is actually
    // connected right now (it may have been disconnected since
    // apiRoutingEngine was last set).
    const cashierConnected = !!merchantUser?.fampay?.isConnected;
    const paytmCashierConnected = !!merchantUser?.paytm?.isConnected;
    const amazonCashierConnected = !!merchantUser?.amazon?.isConnected;
    const finalRoutingEngine =
      (merchantUser?.apiRoutingEngine === 'amazon_cashier' && amazonCashierConnected) ? 'amazon_cashier' :
      (merchantUser?.apiRoutingEngine === 'paytm_cashier' && paytmCashierConnected) ? 'paytm_cashier' :
      (merchantUser?.apiRoutingEngine === 'cashier' && cashierConnected) ? 'cashier' : 'wallet';

    // Hide Wallet System: an order that would fall back to 'wallet' means
    // this merchant has no cashier actually connected right now — once the
    // toggle is on, that's not allowed. This mirrors the check in
    // paymentLinkController's initiatePayment (same rule, ZapAPI's own
    // order-creation path instead of a payment link's checkout).
    if (settings.hideWalletSystemEnabled && finalRoutingEngine === 'wallet') {
      return response.error(res, 'Connect your own FamPay or Paytm cashier before creating orders. Go to Zap API → Payment Routing to connect one.', 403, { requiresCashierConnect: true });
    }

    // PAYTM CASHIER FLOW
    // Mirrors the FamPay cashier flow below, but checkout.html needs the
    // Paytm-specific reference (paytmTxnRef) so paytmService can look this
    // order up against Paytm's own order-status API later. Generated here
    // (not left to checkout.html) so it's already on the payment record
    // the moment the order exists — verifyPayment reads it directly rather
    // than deriving it from the orderId.
    if (finalRoutingEngine === 'paytm_cashier') {
      const paytmTxnRef = 'PTM' + Date.now() + Math.random().toString(36).slice(2, 8).toUpperCase();
      await firebaseService.createPayment(orderId, {
        userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api',
        routingEngine: 'paytm_cashier', paymentMethod: 'paytm', status: 'pending', commissionPercent,
        paytmTxnRef,
      });

      const upiIdToUse = merchantUser?.paytm?.upiId || '';
      const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: amt, upiId: upiIdToUse, redirectUrl: redirect_url || '', method: 'paytm', timeoutSec: checkoutTimeoutSec })
        + `&txn_ref=${encodeURIComponent(paytmTxnRef)}`;

      logger.info(`Paytm Cashier ZapAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

      return response.success(res, 'Order created via Paytm Cashier', {
        order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'paytm_cashier',
        upi_id: upiIdToUse, qr_string: buildUpiDeepLink(upiIdToUse, amt, orderId, merchantUser?.merchantDisplayName),
      });
    }

    // AMAZON PAY CASHIER FLOW
    // Same shape as the FamPay cashier flow below: the merchant's own
    // Amazon Pay UPI ID collects the money, and amazonService verifies it
    // from the merchant's Gmail ("You have added ₹X ... Amazon Pay Wallet").
    if (finalRoutingEngine === 'amazon_cashier') {
      const upiIdToUse = merchantUser?.amazon?.upiId || '';
      await firebaseService.createPayment(orderId, {
        userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api',
        routingEngine: 'amazon_cashier', paymentMethod: 'amazon', cashierUpiId: upiIdToUse,
        status: 'pending', commissionPercent,
      });

      const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: amt, upiId: upiIdToUse, redirectUrl: redirect_url || '', method: 'amazon', timeoutSec: checkoutTimeoutSec });

      logger.info(`Amazon Pay Cashier ZapAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

      return response.success(res, 'Order created via Amazon Pay Cashier', {
        order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'amazon_cashier',
        upi_id: upiIdToUse, qr_string: buildUpiDeepLink(upiIdToUse, amt, orderId, merchantUser?.merchantDisplayName),
      });
    }

    // CASHIER FLOW
    if (finalRoutingEngine === 'cashier') {
      await firebaseService.createPayment(orderId, { userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api', routingEngine: 'cashier', paymentMethod: 'fampay', status: 'pending', commissionPercent });
      
      const upiIdToUse = merchantUser?.fampay?.upiId || merchantUser?.upiId || ''; 
      const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: amt, upiId: upiIdToUse, redirectUrl: redirect_url || '', timeoutSec: checkoutTimeoutSec });

      logger.info(`Cashier ZapAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

      return response.success(res, 'Order created via Cashier', {
        order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'cashier',
        upi_id: upiIdToUse, qr_string: buildUpiDeepLink(upiIdToUse, amt, orderId, merchantUser?.merchantDisplayName),
      });
    }

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, { 
        userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api', 
        routingEngine: isSystemCashier ? 'system_cashier' : 'wallet', 
        status: 'pending', commissionPercent,
        paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
        cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
        fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    const redirectParams = (result) => redirect_url ? `${redirect_url}${redirect_url.includes('?') ? '&' : '?'}zp_order=${orderId}&zp_result=${result}` : undefined;
    
    if (isSystemCashier) {
        // Theme/customization comes from merchantUser (whoever's ZapAPI key
        // created this order), not sysAdminUser — the checkout page shows
        // to THIS merchant's customer, so it should carry this merchant's
        // branding even though the UPI collection itself routes through
        // the system admin's connected FamPay.
        const successRedir = redirectParams('success');
        const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: amt, upiId: sysAdminUser.fampay.upiId, redirectUrl: successRedir || '', timeoutSec: checkoutTimeoutSec });
        webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});
        return response.success(res, 'Order created via System Cashier', {
          order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'system_cashier',
          upi_id: sysAdminUser.fampay.upiId, qr_string: buildUpiDeepLink(sysAdminUser.fampay.upiId, amt, orderId, merchantUser?.merchantDisplayName),
        });
    }

    // WALLET FLOW
    const zapOrder = await zapService.createOrder({
      orderId, amount: String(amt.toFixed(2)), customerMobile: customer_mobile || '', remark,
      omitRedirectUrls: !!useEmbedded && !redirect_url,
      ...(redirect_url ? { successUrl: redirectParams('success'), failedUrl: redirectParams('failed'), timeoutUrl: redirectParams('failed') } : {}),
    });

    // Defensive patch: ZapUPI's own create-order API (pay.zapupi.com,
    // external — not our code) is expected to return a payment_url that
    // already carries order_id + amount when it points at our own
    // checkout.html. It has been observed NOT to (payment_url comes back
    // as e.g. "checkout.html?amount=1&redirect_url=..." with order_id
    // missing entirely) — since we can't fix ZapUPI's own response
    // construction from here, we make sure checkout.html always gets
    // what it needs by injecting order_id ourselves whenever the
    // returned payment_url is one of our own checkout.html links and is
    // missing it. Left untouched for any other (genuinely external)
    // payment_url, so this can't accidentally corrupt a real ZapUPI-
    // hosted checkout page URL that has its own unrelated structure.
    let finalPaymentUrl = zapOrder.paymentUrl;
    try {
      const u = new URL(finalPaymentUrl);
      if (u.pathname.endsWith('/checkout.html') && !u.searchParams.has('order_id')) {
        u.searchParams.set('order_id', orderId);
        if (!u.searchParams.has('amount')) u.searchParams.set('amount', String(amt));
        finalPaymentUrl = u.toString();
        logger.warn(`ZapUPI payment_url was missing order_id for order ${orderId} — patched before returning to client.`);
      }
    } catch (e) {
      // If paymentUrl isn't a parseable absolute URL for some reason,
      // leave it exactly as ZapUPI returned it rather than guessing.
    }

    logger.info(`ZapAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
    webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

    return response.success(res, 'Order created', {
      order_id: orderId, payment_url: finalPaymentUrl, amount: amt, mode: 'live', method: 'wallet',
      // Wallet-routed orders settle through ZapUPI's own hosted checkout,
      // not a UPI ID this backend controls — there is no deep-link to
      // build, so the SDK falls back to iframe/redirect for these.
      upi_id: null, qr_string: null,
    });
  } catch (err) {
    logger.error('ZapAPI create-order error:', err.message);
    return response.error(res, err.message || 'Failed to create order');
  }
};

const getOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment || payment.userId !== req.user.uid) return response.notFound(res, 'Order not found');
    return response.success(res, 'Status fetched', { order_id: orderId, status: payment.status, amount: payment.amount, ...require('../services/merchantPromoService').orderPromoFields(payment) });
  } catch (err) {
    logger.error('ZapAPI order-status error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getPublicOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Order not found');

    // Test Mode orders (isTest) are resolved ONLY by the simulator
    // (gatewayTestController.simulateResult, via the floating test button
    // on the checkout page) — never by real verification. Without this
    // guard, polling a pending test order every 15s would run
    // fampayService.verifyPayment against the merchant's REAL FamPay
    // inbox: wasted IMAP scans at best, and at worst a coincidental
    // amount match could mark a fake test order "success" and burn a real
    // customer's UTR. Just report the stored status back as-is.
    if (payment.isTest) {
      return response.success(res, 'Status fetched', {
        order_id: orderId,
        status: payment.status,
        amount: payment.amount,
        utr: null,
        mode: 'test',
      });
    }

    // 'ambiguous' (Amount+Time Mode — fampayService.verifyPayment) is kept
    // re-checkable here exactly like 'pending': the colliding sibling
    // order may have resolved since the last poll, which can turn an
    // ambiguous match into a deterministic one on the next check.
    if (payment.status === 'pending' || payment.status === 'ambiguous') {
      const now = Date.now();
      const lastCheck = payment.lastImapCheck || 0;
      
      // 5s, not 15s: amount-only matching against the single latest email
      // (fampayService.verifyPayment) is cheap and safe enough to run
      // this often — see that file's top-of-function notes for why the
      // old time-window matching was dropped entirely in favor of this.
      if (now - lastCheck > 2000) {
        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ lastImapCheck: now });
        
        try {
          // Dispatch to the right verifier for how this order was routed —
          // a Paytm-routed order (has its own paytmTxnRef) is checked
          // against Paytm's own order-status API; everything else falls
          // back to the FamPay inbox-scraping verifier as before.
          const verifierService = payment.paytmTxnRef
            ? require('../services/paytmService')
            : (payment.paymentMethod === 'amazon'
              ? require('../services/amazonService')
              : require('../services/fampayService'));
          if (verifierService && typeof verifierService.verifyPayment === 'function') {
            await verifierService.verifyPayment(orderId);
          }
        } catch (verifyErr) {
          logger.warn(`Auto-verify trigger warning for ${orderId}:`, verifyErr.message);
        }
        
        const updatedPayment = await firebaseService.getPayment(orderId);
        if (updatedPayment) {
          payment.status = updatedPayment.status;
          payment.utr = updatedPayment.utr || updatedPayment.txnId;
          payment.payerName = updatedPayment.payerName || null;
        }
      }
    }

    return response.success(res, 'Status fetched', { 
      order_id: orderId, 
      status: payment.status, 
      amount: payment.amount,
      utr: payment.utr || payment.txnId || null,
      ...require('../services/merchantPromoService').orderPromoFields(payment),
      // Sender name as FamPay's own email stated it (fampayService.js /
      // historyController.js's `name` field) — shown on the checkout
      // page's success popup so the merchant/customer can see who the
      // money actually came from. Only ever present once status is
      // 'success'; null otherwise.
      payerName: payment.payerName || null,
    });
  } catch (err) {
    logger.error('Public order-status error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/developer/public-order-peek/:orderId
 * Public (No Auth Required) — backs the checkout page's manual "Refresh
 * if payment not verified" button. Unlike getPublicOrderStatus above
 * (which self-throttles the real mailbox check to once every 5s so the
 * page's own background polling doesn't hammer Gmail), a human
 * deliberately tapping Refresh gets an immediate, unthrottled check —
 * and if that still doesn't verify the order (e.g. the match is
 * ambiguous, or nothing's arrived yet), also returns a non-committing
 * "peek" at the mailbox's latest email so the page can show "₹X from
 * <name> was just detected" even while the order itself stays pending.
 * See fampayService.peekLatestTransaction for why that peek can only
 * ever be for THIS order's exact amount, never anyone else's.
 */
const publicOrderPeek = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.error(res, 'Order not found.', 404);

    if (payment.isTest) {
      return response.success(res, 'Status fetched', {
        order_id: orderId, status: payment.status, amount: payment.amount,
        utr: null, payerName: null, peek: null, mode: 'test',
      });
    }

    if (payment.status === 'pending' || payment.status === 'ambiguous') {
      try {
        const verifierService = payment.paytmTxnRef
          ? require('../services/paytmService')
          : (payment.paymentMethod === 'amazon'
            ? require('../services/amazonService')
            : require('../services/fampayService'));
        if (verifierService && typeof verifierService.verifyPayment === 'function') {
          await verifierService.verifyPayment(orderId);
        }
      } catch (verifyErr) {
        logger.warn(`publicOrderPeek verify trigger warning for ${orderId}:`, verifyErr.message);
      }
    }

    const updated = await firebaseService.getPayment(orderId);

    let peek = null;
    if (!payment.paytmTxnRef && (updated.status === 'pending' || updated.status === 'ambiguous')) {
      peek = await (payment.paymentMethod === 'amazon'
        ? require('../services/amazonService')
        : require('../services/fampayService')).peekLatestTransaction(orderId);
    }

    return response.success(res, 'Status fetched', {
      order_id: orderId,
      status: updated.status,
      amount: updated.amount,
      utr: updated.utr || updated.txnId || null,
      payerName: updated.payerName || null,
      peek,
    });
  } catch (err) {
    logger.error('Public order-peek error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/developer/cancel-order
 * Public (No Auth Required) — called from checkout.html when the customer
 * confirms "Cancel Order", or when the payment session times out. Marks
 * the order 'cancelled'/'timeout' server-side so it actually stops here
 * instead of the button only *looking* like it worked while the order
 * stays 'pending' forever (and could still be paid/marked success later
 * by a stray webhook or a slow UPI confirmation).
 * Body: { orderId, reason? } — reason is 'cancelled' (default) or 'timeout'.
 */
const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    const reason = req.body.reason === 'timeout' ? 'timeout' : 'cancelled';
    if (!orderId) return response.error(res, 'Order ID is required', 400);

    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Order not found');

    // Already-final states must not be clobbered by a late/duplicate cancel
    // click — e.g. the UPI payment actually went through a second before
    // the customer hit Cancel (or right as the timer hit 0), or they
    // double-tap the confirm button / the timer fires while a cancel
    // request is already in flight.
    if (payment.status === 'success') {
      return response.error(res, 'This order is already paid and cannot be cancelled', 409, { status: 'success' });
    }
    if (payment.status === 'cancelled' || payment.status === 'timeout') {
      return response.success(res, `Order already ${payment.status}`, { order_id: orderId, status: payment.status });
    }
    if (payment.status !== 'pending') {
      return response.error(res, `Order cannot be cancelled (current status: ${payment.status})`, 409, { status: payment.status });
    }

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: reason,
      updatedAt: Date.now(),
    });

    webhookService.notifyUserWebhooks(payment.userId, reason === 'timeout' ? 'order.timeout' : 'order.cancelled', {
      order_id: orderId,
      status: reason,
      amount: payment.amount,
    }).catch(() => {});

    logger.info(`Order ${reason} by customer: ${orderId}`);

    return response.success(res, `Order ${reason} successfully`, { order_id: orderId, status: reason });
  } catch (err) {
    logger.error('Cancel order error:', err.message);
    return response.serverError(res, err.message);
  }
};

const verifyUtr = async (req, res) => {
  try {
    const { orderId, utr } = req.body;
    if (!orderId || !utr) {
      return response.error(res, 'Order ID and UTR/Txn ID are required', 400);
    }

    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Order not found');

    // Test Mode orders (isTest) are only ever resolved by the simulator
    // (gatewayTestController.simulateResult) — never by a typed-in UTR,
    // and never with a real order.success webhook. Without this guard a
    // test order could be flipped to 'success' here and fire a REAL
    // webhook at the merchant's server for money that never existed.
    if (payment.isTest) {
      return response.error(res, 'This is a Test Mode order — use the test button on the checkout page to simulate a result.', 400);
    }

    if (payment.status === 'success') {
      return response.success(res, 'Order is already verified', { order_id: orderId, status: 'success', utr: payment.utr });
    }

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ 
      utr: utr, 
      status: 'success',
      updatedAt: Date.now()
    });

    webhookService.notifyUserWebhooks(payment.userId, 'order.success', { 
      order_id: orderId, 
      status: 'success', 
      amount: payment.amount, 
      utr: utr 
    }).catch((e) => {});
    
    logger.info(`Manual UTR verified successfully for order: ${orderId} with UTR: ${utr}`);

    return response.success(res, 'Verified successfully', { order_id: orderId, status: 'success', utr });
  } catch (err) {
    logger.error('Verify UTR error:', err.message);
    return response.serverError(res, err.message);
  }
};

const checkFullOrderJson = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.status(200).json({ success: true, message: 'Full order details', data: payment });
  } catch (err) {
    logger.error('Check Full Order error:', err.message);
    return res.status(500).json({ success: false, message: 'Server Error: ' + err.message });
  }
};

module.exports = {
  getMyToken,
  regenerateMyToken,
  createOrder,
  createOrderValidation,
  getOrderStatus,
  getMode,
  setMode,
  setRoutingEngine,
  getPublicOrderStatus,
  publicOrderPeek,
  cancelOrder,
  verifyUtr,
  checkFullOrderJson
};
