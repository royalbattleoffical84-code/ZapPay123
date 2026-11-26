// services/firebaseService.js - Firebase RTDB Operations
const { ref, serverTimestamp, admin } = require('../firebase/admin');
const { DB_PATHS, DEFAULT_SETTINGS, ZAP_CREDIT_SIGNUP_GRANT } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * =============================
 * USER OPERATIONS
 * =============================
 */

/**
 * Get user by UID
 */
async function getUser(uid) {
  const snap = await ref(`${DB_PATHS.USERS}/${uid}`).once('value');
  return snap.exists() ? { uid, ...snap.val() } : null;
}

/**
 * Generate a unique, human-shareable referral code (e.g. ZAP6UTQV85ZO)
 */
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `ZAP${suffix}`;
}

/**
 * Resolve a referral code to the referrer's UID (returns null if not found)
 */
async function getUidByReferralCode(code) {
  if (!code) return null;
  const snap = await ref(`${DB_PATHS.REFERRAL_CODES}/${code.trim().toUpperCase()}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Create or update user on login
 */
async function upsertUser(uid, data) {
  const userRef = ref(`${DB_PATHS.USERS}/${uid}`);
  const snap = await userRef.once('value');
  const isNewUser = !snap.exists();

  if (!snap.exists()) {
    const myReferralCode = generateReferralCode();
    const settings = await getSettings();
    const signupBonus = settings.signupBonus || 0;
    const zapCreditGrant = settings.signupZapCredit ?? ZAP_CREDIT_SIGNUP_GRANT;

    let referredBy = null;
    let bonusGranted = 0;
    if (data.referralCode) {
      const referrerUid = await getUidByReferralCode(data.referralCode);
      if (referrerUid && referrerUid !== uid) {
        referredBy = referrerUid;
        bonusGranted = signupBonus;
      }
    }

    await userRef.set({
      uid,
      email: data.email,
      displayName: data.displayName || '',
      photoURL: data.photoURL || '',
      role: 'user',
      wallet: { balance: 0, bonusBalance: bonusGranted, zapCredit: zapCreditGrant, lastUpdated: serverTimestamp() },
      isActive: true,
      isBanned: false,
      referralCode: myReferralCode,
      referredBy,
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });

    await ref(`${DB_PATHS.REFERRAL_CODES}/${myReferralCode}`).set(uid);

    if (referredBy) {
      await ref(`${DB_PATHS.REFERRALS}/${referredBy}/${uid}`).set({
        referredUid: uid,
        referrerUid: referredBy,
        name: data.displayName || 'User',
        email: data.email || '',
        status: 'waiting',
        signupBonusGiven: bonusGranted > 0,
        signupBonus: bonusGranted,
        purchaseAmount: null,
        commissionPercent: settings.referralCommissionPercent || 25,
        commission: null,
        createdAt: serverTimestamp(),
        completedAt: null,
      });
    }
  } else {
    const existing = snap.val();
    const updates = {
      displayName: data.displayName || existing.displayName,
      photoURL: data.photoURL || existing.photoURL,
      lastLoginAt: serverTimestamp(),
    };
    if (!existing.referralCode) {
      const myReferralCode = generateReferralCode();
      updates.referralCode = myReferralCode;
      await ref(`${DB_PATHS.REFERRAL_CODES}/${myReferralCode}`).set(uid);
    }
    // Zap Credit backfill — existing users (created before this feature)
    // never got the signup grant, so give it once here. Guarded by the
    // field's absence so this never re-grants on later logins.
    if (existing.wallet?.zapCredit === undefined) {
      const settings = await getSettings();
      updates['wallet/zapCredit'] = settings.signupZapCredit ?? ZAP_CREDIT_SIGNUP_GRANT;
      updates['wallet/zapCreditLastUpdated'] = serverTimestamp();
    }
    await userRef.update(updates);
  }

  const updated = await userRef.once('value');
  return { uid, ...updated.val(), isNewUser };
}

/**
 * Update user profile
 */
async function updateUserProfile(uid, data) {
  const allowed = ['displayName', 'phone', 'upiId', 'upiHolderName', 'bankDetails', 'checkoutTheme', 'checkoutThemeColor', 'paymentLinkTheme', 'paymentLinkThemeColor', 'showOnboarding', 'hideIntent', 'storeLogoUrl', 'merchantDisplayName'];
  const update = {};
  allowed.forEach((key) => {
    if (data[key] !== undefined) update[key] = data[key];
  });
  update.updatedAt = serverTimestamp();
  await ref(`${DB_PATHS.USERS}/${uid}`).update(update);
}

/**
 * Get all users (admin)
 */
async function getAllUsers() {
  const snap = await ref(DB_PATHS.USERS).once('value');
  if (!snap.exists()) return [];
  const users = [];
  snap.forEach((child) => {
    const user = child.val();
    users.push({
      uid: child.key,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      role: user.role,
      walletBalance: user.wallet?.balance || 0,
      isActive: user.isActive,
      isBanned: user.isBanned,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    });
  });
  return users.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Ban or unban user
 */
async function setBanStatus(uid, isBanned, reason = '') {
  await ref(`${DB_PATHS.USERS}/${uid}`).update({
    isBanned,
    banReason: isBanned ? (reason || '').trim() : '',
    bannedAt: isBanned ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Full activity timeline for one user
 */
async function getUserActivityLog(uid, limit = 300) {
  const snap = await ref(DB_PATHS.ACTIVITY_LOGS).orderByChild('userId').equalTo(uid).limitToLast(limit).once('value');
  const logs = [];
  if (snap.exists()) snap.forEach((child) => logs.push(child.val()));
  logs.sort((a, b) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0));
  return logs;
}

/**
 * =============================
 * PAYMENT OPERATIONS
 * =============================
 */

/**
 * Create a payment record
 */
async function createPayment(orderId, data) {
  await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).set({
    orderId,
    userId: data.userId,
    amount: parseFloat(data.amount),
    status: data.status || 'pending',
    remark: data.remark || '',
    customerMobile: data.customerMobile || '',
    customerName: data.customerName || '',
    customerEmail: data.customerEmail || '',
    linkId: data.linkId || null,
    type: data.type || 'wallet_topup',
    planId: data.planId || null,
    durationMonths: data.durationMonths || null,
    durationDays: data.durationDays || null,
    commissionPercent: data.commissionPercent || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    environment: null,
    isTest: !!data.isTest,
    testRedirectUrl: data.testRedirectUrl || null,
    testUseEmbedded: !!data.testUseEmbedded,
    testResult: null,
    paymentMethod: data.paymentMethod || 'zapupi',
    cashierUpiId: data.cashierUpiId || null,
    fampayVerifyUid: data.fampayVerifyUid || null,
    storeId: data.storeId || null,
    productId: data.productId || null,
    routingEngine: data.routingEngine || 'wallet',
    couponId: data.couponId || null,
    couponDiscountPercent: data.couponDiscountPercent || null,
    txnId: null,
    utr: null,
  });
}

/**
 * Update payment status (webhook)
 */
async function updatePaymentStatus(orderId, data) {
  const normalizedStatus =
    data.status === 'Success' ? 'success' :
    data.status === 'Failed'  ? 'failed'  :
    'pending';

  const update = {
    status: normalizedStatus,
    txnId: data.txn_id || '',
    utr: data.utr || '',
    payAmount: parseFloat(data.pay_amount || data.amount || 0),
    environment: data.environment || 'cashier',
    updatedAt: serverTimestamp(),
  };
  await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update(update);
}

/**
 * Get payment by orderId
 */
async function getPayment(orderId) {
  const snap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Get pending orders that were routed through Paytm (have a paytmTxnRef),
 * created within the last `maxAgeMs` (default 24h — no point re-checking
 * something from a week ago forever). Powers the background Paytm
 * verification cron: unlike FamPay (which has its own inbox-driven
 * webhook path) or ZapUPI (which has a real webhook), Paytm orders here
 * previously ONLY got verified if the customer's own browser stayed on
 * the checkout page long enough to poll — closing the tab, a network
 * blip, or the page never fully loading meant the order stayed 'pending'
 * forever even though Paytm had genuinely received the money. This cron
 * is the fix: it checks every still-pending Paytm order against Paytm's
 * own order-status API on a schedule, independent of any customer's
 * browser session.
 */
async function getPendingPaytmOrders(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('createdAt')
    .startAt(cutoff)
    .once('value');

  if (!snap.exists()) return [];
  const out = [];
  snap.forEach((child) => {
    const p = child.val();
    if (p.status === 'pending' && p.paytmTxnRef) {
      out.push({ orderId: child.key, ...p });
    }
  });
  return out;
}

/**
 * Orders that were marked 'cancelled' or 'timeout' recently (by
 * cancelOrder in developerController.js — the checkout page's timer
 * expiring, or the customer tapping Cancel) that are STILL worth
 * re-checking against FamPay: a real, documented gap is a customer whose
 * first payment attempt fails client-side (e.g. a UPI app's own "₹2,000
 * gallery-scan QR limit" popup) and who then retries a different way
 * (downloading the QR, scanning from gallery) — succeeding, but only
 * after the checkout's own timer had already expired and cancelled the
 * order. The money is real and already in the merchant's FamPay account;
 * without a sweep like this nothing ever looks at that order again.
 * Bounded to the same window fampayService.verifyPayment's
 * LATE_RECONCILE_WINDOW_MS enforces (so this list naturally stays short
 * on every run — cancelled orders age out of it after that window,
 * exactly when verifyPayment would also start refusing them).
 */
async function getRecentlyCancelledFampayOrders(windowMs = 30 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('updatedAt')
    .startAt(cutoff)
    .once('value');

  if (!snap.exists()) return [];
  const out = [];
  snap.forEach((child) => {
    const p = child.val();
    if ((p.status === 'cancelled' || p.status === 'timeout') && p.fampayVerifyUid) {
      out.push({ orderId: child.key, ...p });
    }
  });
  return out;
}

/**
 * Still-'pending' (or 'ambiguous') FamPay-routed orders, within their
 * own recent lifetime. Exists for the SAME reason getPendingPaytmOrders
 * does (see its comment above) — but until now nothing covered the
 * FamPay equivalent: verification for a FamPay order only ever ran when
 * the customer's own browser was actively polling the checkout page
 * (getPublicOrderStatus). If that tab was backgrounded or suspended —
 * e.g. the customer switched to their UPI app to pay and the mobile
 * browser throttled/paused the tab's JS timers while they were away —
 * polling stalls, and getRecentlyCancelledFampayOrders above doesn't
 * help either, since the order is still 'pending', not yet
 * 'cancelled'/'timeout'. The customer can genuinely have paid and
 * reopened the tab to find nothing happened.
 *
 * windowMs is intentionally short (20 min default, comfortably above
 * even the old 8-minute Normal Mode timeout) — this is a safety-net
 * sweep for orders that are still within their own valid window, not a
 * general-purpose backlog scanner; a far-older pending order is either
 * already handled by the frontend's own cancelOrder() + late-reconcile
 * path, or genuinely abandoned.
 */
async function getPendingFampayOrders(windowMs = 20 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('createdAt')
    .startAt(cutoff)
    .once('value');

  if (!snap.exists()) return [];
  const out = [];
  snap.forEach((child) => {
    const p = child.val();
    if ((p.status === 'pending' || p.status === 'ambiguous') && p.fampayVerifyUid) {
      out.push({ orderId: child.key, ...p });
    }
  });
  return out;
}

/**
 * Get payments by userId
 */
async function getUserPayments(userId, limit = 50) {
  const RAW_SCAN_SIZE = Math.max(limit * 20, 2000);
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('createdAt')
    .limitToLast(RAW_SCAN_SIZE)
    .once('value');

  if (!snap.exists()) return [];
  const payments = [];
  snap.forEach((child) => {
    const val = child.val();
    if (val && val.userId === userId) payments.push(val);
  });
  return payments.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/**
 * Get all payments (admin)
 */
async function getAllPayments(limit = 100) {
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('createdAt')
    .limitToLast(limit)
    .once('value');
  if (!snap.exists()) return [];
  const payments = [];
  snap.forEach((child) => payments.push(child.val()));
  return payments.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Check if THIS status for this order was already processed.
 * Storing the status (not just a bare timestamp) means a genuine status
 * transition for the same order — e.g. a payment that first webhooks in
 * as Failed and is later corrected to Success by ZapUPI — is treated as
 * new work instead of being silently dropped as a "duplicate". Only a
 * repeat delivery of the SAME status (Zap retrying its own webhook) is
 * skipped.
 */
async function isOrderProcessed(orderId, status) {
  const snap = await ref(`${DB_PATHS.PROCESSED_ORDERS}/${orderId}`).once('value');
  if (!snap.exists()) return false;
  const recorded = snap.val();
  // Back-compat: older entries were written as a bare serverTimestamp
  // (a number), not { status, processedAt }. Treat those as "processed,
  // status unknown" so we don't accidentally reprocess old orders on
  // deploy — but any NEW write always uses the object form below.
  const recordedStatus = recorded && typeof recorded === 'object' ? recorded.status : undefined;
  if (!recordedStatus) return true;
  return recordedStatus === status;
}

/**
 * Mark order as processed for a given status.
 */
async function markOrderProcessed(orderId, status) {
  await ref(`${DB_PATHS.PROCESSED_ORDERS}/${orderId}`).set({ status: status || null, processedAt: serverTimestamp() });
}

/**
 * Release an early claim made by markOrderProcessed
 */
async function unmarkOrderProcessed(orderId) {
  await ref(`${DB_PATHS.PROCESSED_ORDERS}/${orderId}`).remove();
}

/**
 * Get a payment by its UTR (returns the first match)
 */
async function getPaymentByUtr(utr) {
  if (!utr) return null;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('utr')
    .equalTo(utr)
    .once('value');
  if (!snap.exists()) return null;
  let result = null;
  snap.forEach((child) => {
    result = child.val();
  });
  return result;
}

/**
 * Get a payment by its Transaction ID (txnId)
 */
async function getPaymentByTxnId(txnId) {
  if (!txnId) return null;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('txnId')
    .equalTo(txnId)
    .once('value');
  if (!snap.exists()) return null;
  let result = null;
  snap.forEach((child) => {
    result = child.val();
  });
  return result;
}

/**
 * =============================
 * WITHDRAWAL OPERATIONS
 * =============================
 */

/**
 * Create withdrawal request
 */
async function createWithdrawal(userId, data) {
  const withdrawalRef = ref(DB_PATHS.WITHDRAWALS).push();
  const id = withdrawalRef.key;
  const method = data.method === 'bank' ? 'bank' : 'upi';
  const record = {
    id,
    userId,
    method,
    amount: parseFloat(data.amount),
    commission: parseFloat(data.commission),
    netAmount: parseFloat(data.netAmount),
    status: 'pending',
    adminNote: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (method === 'bank') {
    record.accountNumber = data.accountNumber;
    record.ifscCode = data.ifscCode;
    record.accountHolderName = data.accountHolderName;
    record.accountName = data.accountHolderName || '';
  } else {
    record.upiId = data.upiId;
    record.upiHolderName = data.upiHolderName || '';
    record.accountName = data.upiHolderName || '';
  }
  await withdrawalRef.set(record);
  return id;
}

/**
 * Update withdrawal status (admin)
 */
async function updateWithdrawalStatus(withdrawalId, status, adminNote = '') {
  await ref(`${DB_PATHS.WITHDRAWALS}/${withdrawalId}`).update({
    status,
    adminNote,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Get user withdrawals
 */
async function getUserWithdrawals(userId) {
  const snap = await ref(DB_PATHS.WITHDRAWALS)
    .orderByChild('userId')
    .equalTo(userId)
    .once('value');
  if (!snap.exists()) return [];
  const list = [];
  snap.forEach((child) => { const v = child.val(); if (v) list.push(v); });
  return list.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
}

/**
 * Get all withdrawals (admin)
 */
async function getAllWithdrawals() {
  const snap = await ref(DB_PATHS.WITHDRAWALS).once('value');
  if (!snap.exists()) return [];
  const list = [];
  snap.forEach((child) => { const v = child.val(); if (v) list.push(v); });
  return list.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
}

/**
 * Get withdrawal by ID
 */
async function getWithdrawal(withdrawalId) {
  const snap = await ref(`${DB_PATHS.WITHDRAWALS}/${withdrawalId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Mask a UTR/Txn ID for display: keep only the last 4 characters visible
 * (e.g. "********9012"), matching the Admin Panel privacy requirement —
 * the full identifier is never needed to review a verification decision,
 * only enough to spot-check it against the merchant's own bank/FamPay
 * statement if a dispute comes up.
 */
function maskIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return 'N/A';
  if (identifier.length <= 4) return '*'.repeat(identifier.length);
  return '*'.repeat(identifier.length - 4) + identifier.slice(-4);
}

/**
 * Write one verification-decision entry for the Admin Panel's
 * Verification Logs view (fampayService.js / smsWebhookController.js call
 * this at every terminal AUTO/MANUAL decision point).
 *
 * PRIVACY — deliberately excludes, by construction, not by filtering:
 *   - the merchant's connected mailbox address (user.fampay.email)
 *   - IMAP credentials
 *   - raw email subject/body
 * Only derived, already-non-sensitive transaction metadata is accepted
 * here. Callers must mask the identifier themselves via maskIdentifier()
 * before calling this (kept explicit at the call site rather than
 * silently re-masking here, so it's obvious at a glance that no raw UTR
 * ever reaches this function).
 */
async function logVerificationAttempt(entry) {
  try {
    await ref(DB_PATHS.VERIFICATION_LOGS).push({
      orderId: entry.orderId || null,
      amount: entry.amount != null ? parseFloat(entry.amount) : null,
      paymentTime: entry.paymentTime || null, // formatted string, not a raw email timestamp
      utrMasked: entry.utrMasked || 'N/A',
      verificationMethod: entry.verificationMethod || null, // AUTO_PURPOSE | AUTO_AMOUNT_TIME | MANUAL_UTR
      verificationMode: entry.verificationMode || null,      // NORMAL | AMOUNT_TIME
      result: entry.result || null,                          // VERIFIED | REJECTED | AMBIGUOUS
      reason: entry.reason || '',
      processingTimeMs: typeof entry.processingTimeMs === 'number' ? entry.processingTimeMs : null,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    // Logging must never block/break the actual verification flow.
    logger.warn(`logVerificationAttempt failed: ${e.message}`);
  }
}

/**
 * Read recent verification log entries for the Admin Panel. Optionally
 * scoped to one orderId. Returned newest-first.
 */
async function getVerificationLogs({ orderId, limit = 100 } = {}) {
  let query = ref(DB_PATHS.VERIFICATION_LOGS);
  query = orderId ? query.orderByChild('orderId').equalTo(orderId) : query.limitToLast(limit);
  const snap = await query.once('value');
  const logs = [];
  if (snap.exists()) {
    snap.forEach((child) => {
      logs.push({ id: child.key, ...child.val() });
    });
  }
  logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return orderId ? logs.slice(0, limit) : logs;
}

/**
 * =============================
 * PLATFORM SETTINGS
 * =============================
 */

/**
 * SINGLE-DEVICE LOGIN
 */
async function setActiveDevice(uid, deviceId, label) {
  await ref(`${DB_PATHS.USERS}/${uid}/activeDevice`).set({
    deviceId,
    label: label || 'Unknown device',
    loginAt: serverTimestamp(),
  });
}

async function clearActiveDevice(uid) {
  await ref(`${DB_PATHS.USERS}/${uid}/activeDevice`).set(null);
}

async function getSettings() {
  const snap = await ref(DB_PATHS.SETTINGS).once('value');
  if (!snap.exists()) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...snap.val() };
}

/**
 * Update platform settings (admin)
 */
async function updateSettings(data) {
  await ref(DB_PATHS.SETTINGS).update({
    ...data,
    updatedAt: serverTimestamp(),
  });
}

/**
 * =============================
 * ACTIVITY LOG
 * =============================
 */

/**
 * Log an activity
 */
async function logActivity(userId, action, details = {}) {
  const logRef = ref(DB_PATHS.ACTIVITY_LOGS).push();
  await logRef.set({
    userId,
    action,
    details,
    timestamp: serverTimestamp(),
    ip: details.ip || '',
  });
}

/**
 * Permanently delete a user record from the database.
 */
async function getEffectiveWalletLimit(userId) {
  const { DEFAULT_PLANS } = require('../config/constants');
  const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');
  const sub = subSnap.val();
  const planId = (sub && sub.planId) || 'blaze';
  const planSnap = await ref(`${DB_PATHS.PLANS}/${planId}`).once('value');
  const plan = planSnap.val();
  return (plan && plan.walletLimit != null) ? plan.walletLimit
    : (DEFAULT_PLANS[planId] && DEFAULT_PLANS[planId].walletLimit) || DEFAULT_PLANS.blaze.walletLimit;
}

async function deleteUser(uid) {
  const user = await getUser(uid);
  if (user?.referralCode) {
    await ref(`${DB_PATHS.REFERRAL_CODES}/${user.referralCode}`).remove();
  }
  await ref(`${DB_PATHS.USERS}/${uid}`).remove();
}

/**
 * Delete all "unverified" users in one shot
 */
async function deleteUnverifiedUsers() {
  const snap = await ref(DB_PATHS.USERS).once('value');
  if (!snap.exists()) return [];
  const toDelete = [];
  snap.forEach((child) => {
    const u = child.val();
    if (!u) return;
    const noName = !u.displayName || !String(u.displayName).trim();
    const noEmail = !u.email || !String(u.email).trim();
    const noBalance = !u.wallet?.balance || u.wallet.balance <= 0;
    if (noName && noEmail && noBalance) toDelete.push(child.key);
  });
  for (const uid of toDelete) {
    await deleteUser(uid);
  }
  return toDelete;
}

/**
 * Increment payment link stats (called from webhook)
 */
async function incrementPaymentLinkStats(linkId, amount) {
  const linkRef = ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`);
  const snap = await linkRef.once('value');
  if (!snap.exists()) return;
  await linkRef.update({
    paymentCount: (snap.val().paymentCount || 0) + 1,
    totalCollected: (snap.val().totalCollected || 0) + parseFloat(amount),
    lastPaidAt: Date.now(),
  });
}

module.exports = {
  // Users
  getUser,
  upsertUser,
  updateUserProfile,
  getAllUsers,
  setBanStatus,
  generateReferralCode,
  getUidByReferralCode,
  deleteUser,
  deleteUnverifiedUsers,
  getEffectiveWalletLimit,
  // Payments
  createPayment,
  updatePaymentStatus,
  getPayment,
  getPendingPaytmOrders,
  getRecentlyCancelledFampayOrders,
  getPendingFampayOrders,
  getUserPayments,
  getAllPayments,
  isOrderProcessed,
  markOrderProcessed,
  unmarkOrderProcessed,
  getPaymentByUtr,
  getPaymentByTxnId,
  maskIdentifier,
  logVerificationAttempt,
  getVerificationLogs,
  // Withdrawals
  createWithdrawal,
  updateWithdrawalStatus,
  getUserWithdrawals,
  getAllWithdrawals,
  getWithdrawal,
  // Settings
  getSettings,
  updateSettings,
  setActiveDevice,
  clearActiveDevice,
  // Logs
  logActivity,
  getUserActivityLog,
  // Misc
  incrementPaymentLinkStats,
};
