// services/airdropService.js
//
// "Weekly Airdrop" — once per ISO week (resetting every Monday 00:00 IST),
// a user can claim a random discount coupon (10–30% off, weighted toward
// the lower end) redeemable on their next subscription purchase.
//
// Two collections back this (see config/constants.js DB_PATHS):
//   AIRDROP_CLAIMS/<uid>/<weekKey>  — one row per user per week, the gate
//                                     that enforces "once per week"
//   USER_COUPONS/<uid>/<couponId>   — the actual coupon, independent of
//                                     the claim record so a coupon can
//                                     outlive the week it was claimed in
//                                     (7-day expiry from claim time)
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');

const COUPON_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days from claim
const IST_OFFSET_MS = 330 * 60 * 1000;

// Weighted odds, as given: 10–15% (40%), 16–20% (30%), 21–25% (20%), 26–30% (10%).
// Each band's actual percent is a random integer within that band, so the
// reward isn't just one of 4 fixed values.
const BANDS = [
  { min: 10, max: 15, weight: 40 },
  { min: 16, max: 20, weight: 30 },
  { min: 21, max: 25, weight: 20 },
  { min: 26, max: 30, weight: 10 },
];

function rollDiscountPercent() {
  const totalWeight = BANDS.reduce((sum, b) => sum + b.weight, 0); // 100
  let roll = Math.random() * totalWeight;
  for (const band of BANDS) {
    if (roll < band.weight) {
      return band.min + Math.floor(Math.random() * (band.max - band.min + 1));
    }
    roll -= band.weight;
  }
  return BANDS[0].min; // unreachable in practice, just a safe fallback
}

// ISO-ish week key, weeks starting Monday, computed in IST (not server
// local time, which on Vercel is UTC and would reset at the wrong hour
// for an India-facing "every Monday" promise).
function getWeekKey(atMs = Date.now()) {
  const ist = new Date(atMs + IST_OFFSET_MS);
  const day = ist.getUTCDay(); // 0=Sun..6=Sat, in the shifted "IST" clock
  const diffToMonday = (day === 0 ? 6 : day - 1);
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - diffToMonday));
  return monday.toISOString().slice(0, 10); // "YYYY-MM-DD" of that week's Monday
}

// When the CURRENT week's claim window ends (next Monday 00:00 IST), as a
// real epoch ms — what the frontend countdown/reset timer is driven by.
function getNextMondayResetAt(atMs = Date.now()) {
  const ist = new Date(atMs + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  const daysUntilNextMonday = day === 0 ? 1 : (8 - day);
  const nextMondayIstMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysUntilNextMonday);
  return nextMondayIstMidnight - IST_OFFSET_MS;
}

function newCouponId() {
  return `AD${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

/**
 * What the frontend needs to render the floating widget: can the user
 * claim right now, and if not, when does the window reset + what did
 * they already get this week.
 */
async function getClaimStatus(userId) {
  const weekKey = getWeekKey();
  const claimSnap = await ref(`${DB_PATHS.AIRDROP_CLAIMS}/${userId}/${weekKey}`).once('value');
  const resetAt = getNextMondayResetAt();

  if (!claimSnap.exists()) {
    return { canClaim: true, resetAt, weekKey, claimedCoupon: null };
  }

  const claim = claimSnap.val();
  const couponSnap = await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${claim.couponId}`).once('value');
  return { canClaim: false, resetAt, weekKey, claimedCoupon: couponSnap.exists() ? couponSnap.val() : null };
}

/**
 * Claims this week's airdrop. Rejects outright if already claimed this
 * week — rerolling by spamming the endpoint is not possible since the
 * claim record is written atomically as part of this same call via a
 * conditional check against existing data (Firebase doesn't have a
 * native CAS here, so this relies on the week-keyed path itself: a
 * second claim this week always finds the first one's record already
 * present and refuses before generating anything).
 */
async function claimWeeklyAirdrop(userId) {
  const weekKey = getWeekKey();
  const claimRef = ref(`${DB_PATHS.AIRDROP_CLAIMS}/${userId}/${weekKey}`);
  const alreadyClaimedErr = () => {
    const err = new Error('You already claimed this week\'s airdrop. Come back next Monday!');
    err.alreadyClaimed = true;
    return err;
  };

  const discountPercent = rollDiscountPercent();
  const couponId = newCouponId();
  const now = Date.now();

  // Atomic claim: the transaction only commits if no claim exists yet for
  // this week, so two simultaneous requests (double tap, two tabs) can
  // never both succeed and hand out two coupons.
  const txn = await claimRef.transaction((current) => (current ? undefined : { claimedAt: now, discountPercent, couponId }));
  if (!txn.committed) throw alreadyClaimedErr();

  const coupon = {
    id: couponId,
    discountPercent,
    source: 'weekly_airdrop',
    status: 'active', // active | used | expired(computed, not stored)
    grantedAt: now,
    expiresAt: now + COUPON_VALIDITY_MS,
    usedAt: null,
    usedOnOrderId: null,
  };

  try {
    await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${couponId}`).set(coupon);
  } catch (err) {
    // Coupon could not be saved — release this week's claim so the user
    // is not left with a "claimed" week and no coupon.
    await claimRef.remove().catch(() => {});
    throw err;
  }

  logger.info(`Weekly airdrop claimed: user=${userId} week=${weekKey} discount=${discountPercent}%`);
  return coupon;
}

function isCouponUsable(coupon) {
  return coupon && coupon.status === 'active' && coupon.expiresAt > Date.now();
}

async function listMyCoupons(userId) {
  const snap = await ref(`${DB_PATHS.USER_COUPONS}/${userId}`).once('value');
  const list = [];
  if (snap.exists()) snap.forEach((c) => list.push(c.val()));
  list.sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
  // Computed, not stored: a coupon past its expiry is shown as expired
  // even though its stored status still says 'active' (there's no cron
  // sweeping these — expiry is purely a read-time check everywhere).
  return list.map((c) => ({
    ...c,
    status: c.status === 'active' && c.expiresAt <= Date.now() ? 'expired' : c.status,
  }));
}

/**
 * Validates a coupon belongs to this user and is currently usable, and
 * returns the discounted amount. Does NOT mark it used — that only
 * happens once an order is actually created (see markCouponUsed), so a
 * validation call alone (e.g. a price preview) never burns the coupon.
 */
async function previewDiscount(userId, couponId, baseAmount) {
  if (!couponId) return { finalAmount: baseAmount, coupon: null };

  const snap = await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${couponId}`).once('value');
  if (!snap.exists()) throw new Error('Coupon not found.');
  const coupon = snap.val();
  if (!isCouponUsable(coupon)) throw new Error('This coupon has expired or was already used.');

  const finalAmount = Math.round(baseAmount * (1 - coupon.discountPercent / 100) * 100) / 100;
  return { finalAmount, coupon };
}

/** Called once an order built from a coupon-discounted amount actually exists. */
async function markCouponUsed(userId, couponId, orderId) {
  if (!couponId) return;
  await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${couponId}`).update({
    status: 'used',
    usedAt: Date.now(),
    usedOnOrderId: orderId || null,
  });
}

/**
 * Admin tool: give a user a coupon directly (support gesture, contest prize…).
 * Same shape as a weekly-airdrop coupon so it works everywhere a coupon does.
 */
async function adminGrantCoupon(userId, discountPercent, validityDays) {
  const pct = Number(discountPercent);
  const days = Number(validityDays);
  if (!Number.isInteger(pct) || pct < 1 || pct > 50) throw new Error('Discount must be a whole number between 1 and 50.');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Validity must be between 1 and 90 days.');
  const now = Date.now();
  const coupon = {
    id: newCouponId(), discountPercent: pct, source: 'admin_grant', status: 'active',
    grantedAt: now, expiresAt: now + days * 24 * 60 * 60 * 1000, usedAt: null, usedOnOrderId: null,
  };
  await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${coupon.id}`).set(coupon);
  return coupon;
}

/** Admin tool: cancel an unused coupon. Used coupons cannot be revoked. */
async function adminRevokeCoupon(userId, couponId) {
  const tx = await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${couponId}`).transaction((cur) => {
    if (cur === null) return cur;
    if (cur.status !== 'active') return undefined;
    cur.status = 'revoked';
    cur.revokedAt = Date.now();
    return cur;
  });
  if (!tx.committed) {
    const snap = await ref(`${DB_PATHS.USER_COUPONS}/${userId}/${couponId}`).once('value');
    if (!snap.exists()) throw new Error('Coupon not found.');
    throw new Error(`Only an unused coupon can be revoked (this one is ${snap.val().status}).`);
  }
  if (!tx.snapshot.val()) throw new Error('Coupon not found.');
}

module.exports = {
  adminGrantCoupon,
  adminRevokeCoupon,
  getWeekKey,
  getNextMondayResetAt,
  getClaimStatus,
  claimWeeklyAirdrop,
  listMyCoupons,
  previewDiscount,
  markCouponUsed,
  isCouponUsable,
};
