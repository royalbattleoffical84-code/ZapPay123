// controllers/adminMgmtController.js
// Admin-side oversight of the Management features: staff accounts,
// merchant promo codes and the Weekly Airdrop.
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const firebaseService = require('../services/firebaseService');
const staffService = require('../services/staffService');
const airdropService = require('../services/airdropService');
const notificationService = require('../services/notificationService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const wrap = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof staffService.StaffError) return response.error(res, err.message, err.status, err.extra);
    logger.error(`${label} error: ${err.stack || err.message}`);
    return response.serverError(res, err.message || 'Something went wrong.');
  }
};

async function userMap() {
  const users = await firebaseService.getAllUsers();
  const map = {};
  users.forEach((u) => { map[u.uid] = u; });
  return map;
}
const ownerInfo = (map, uid) => ({ ownerUid: uid, ownerEmail: map[uid]?.email || '', ownerName: map[uid]?.displayName || map[uid]?.name || '' });
const audit = (req, action, details) => firebaseService.logActivity(req.user.uid, action, details).catch(() => {});

/* ───────────── Staff accounts ───────────── */
// GET /api/admin/staff[?uid=ownerUid]
const listStaff = wrap('Admin list staff', async (req, res) => {
  const snap = await ref(DB_PATHS.STAFF).once('value');
  const tree = snap.exists() ? snap.val() : {};
  const users = await userMap();
  const onlyUid = req.query.uid ? String(req.query.uid) : null;
  const rows = [];
  Object.entries(tree).forEach(([ownerUid, members]) => {
    if (onlyUid && ownerUid !== onlyUid) return;
    Object.values(members || {}).forEach((s) => rows.push({ ...staffService.publicView(s), ...ownerInfo(users, ownerUid) }));
  });
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const stats = {
    owners: new Set(rows.map((r) => r.ownerUid)).size,
    total: rows.length,
    active: rows.filter((r) => r.isActive && !r.suspendedByPlan).length,
    disabled: rows.filter((r) => !r.isActive).length,
    overPlan: rows.filter((r) => r.suspendedByPlan).length,
  };
  return response.success(res, 'Staff fetched', { staff: rows, stats });
});

// POST /api/admin/staff/:ownerUid/:staffId/status  { isActive }
const setStaffStatus = wrap('Admin set staff status', async (req, res) => {
  const { ownerUid, staffId } = req.params;
  if (typeof req.body.isActive !== 'boolean') return response.error(res, 'isActive (true/false) is required.');
  const staff = await staffService.updateStaff(ownerUid, staffId, { isActive: req.body.isActive });
  audit(req, 'ADMIN_STAFF_STATUS', { ownerUid, staffId, isActive: req.body.isActive });
  return response.success(res, req.body.isActive ? 'Staff account enabled' : 'Staff account disabled', { staff });
});

// POST /api/admin/staff/:ownerUid/:staffId/logout
const forceStaffLogout = wrap('Admin force staff logout', async (req, res) => {
  await staffService.forceLogout(req.params.ownerUid, req.params.staffId);
  audit(req, 'ADMIN_STAFF_LOGOUT', { ownerUid: req.params.ownerUid, staffId: req.params.staffId });
  return response.success(res, 'Staff member signed out everywhere');
});

// DELETE /api/admin/staff/:ownerUid/:staffId
const removeStaff = wrap('Admin remove staff', async (req, res) => {
  await staffService.removeStaff(req.params.ownerUid, req.params.staffId);
  audit(req, 'ADMIN_STAFF_REMOVED', { ownerUid: req.params.ownerUid, staffId: req.params.staffId });
  return response.success(res, 'Staff account removed');
});

/* ───────────── Merchant promo codes ───────────── */
// GET /api/admin/merchant-promos[?uid=ownerUid]
const listMerchantPromos = wrap('Admin list merchant promos', async (req, res) => {
  const snap = await ref(DB_PATHS.MERCHANT_PROMOS).once('value');
  const tree = snap.exists() ? snap.val() : {};
  const users = await userMap();
  const onlyUid = req.query.uid ? String(req.query.uid) : null;
  const now = Date.now();
  const rows = [];
  Object.entries(tree).forEach(([ownerUid, codes]) => {
    if (onlyUid && ownerUid !== onlyUid) return;
    Object.values(codes || {}).forEach((p) => rows.push({
      code: p.code, type: p.type, value: p.value, minOrder: p.minOrder || 0, maxDiscount: p.maxDiscount || null,
      maxUses: p.maxUses === undefined ? -1 : p.maxUses, used: p.used || 0, discountGiven: Math.round((p.discountGiven || 0) * 100) / 100,
      pending: p.holds ? Object.keys(p.holds).length : 0, isActive: !!p.isActive, adminLocked: !!p.adminLocked,
      expiresAt: p.expiresAt || null, expired: !!(p.expiresAt && now > p.expiresAt), note: p.note || '',
      createdAt: p.createdAt || null, createdBy: p.createdBy || '', ...ownerInfo(users, ownerUid),
    }));
  });
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const stats = {
    merchants: new Set(rows.map((r) => r.ownerUid)).size,
    total: rows.length,
    active: rows.filter((r) => r.isActive && !r.expired).length,
    redemptions: rows.reduce((s, r) => s + r.used, 0),
    discountGiven: Math.round(rows.reduce((s, r) => s + r.discountGiven, 0) * 100) / 100,
  };
  return response.success(res, 'Merchant promo codes fetched', { promos: rows, stats });
});

// PUT /api/admin/merchant-promos/:ownerUid/:code/toggle
// Disabling by admin LOCKS the code (the merchant cannot switch it back on).
const toggleMerchantPromo = wrap('Admin toggle merchant promo', async (req, res) => {
  const { ownerUid } = req.params;
  const code = String(req.params.code || '').toUpperCase();
  const pRef = ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}`);
  const snap = await pRef.once('value');
  if (!snap.exists()) return response.notFound(res, 'Promo code not found');
  const nowActive = !snap.val().isActive;
  await pRef.update({ isActive: nowActive, adminLocked: !nowActive, updatedAt: Date.now() });
  audit(req, 'ADMIN_MERCHANT_PROMO_TOGGLED', { ownerUid, code, isActive: nowActive });
  return response.success(res, nowActive ? 'Promo code re-enabled' : 'Promo code disabled and locked', { isActive: nowActive });
});

// DELETE /api/admin/merchant-promos/:ownerUid/:code
const deleteMerchantPromo = wrap('Admin delete merchant promo', async (req, res) => {
  const { ownerUid } = req.params;
  const code = String(req.params.code || '').toUpperCase();
  const pRef = ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}`);
  const snap = await pRef.once('value');
  if (!snap.exists()) return response.notFound(res, 'Promo code not found');
  await pRef.remove();
  audit(req, 'ADMIN_MERCHANT_PROMO_DELETED', { ownerUid, code });
  return response.success(res, 'Promo code deleted');
});

/* ───────────── Weekly Airdrop ───────────── */
// GET /api/admin/airdrop
const airdropOverview = wrap('Admin airdrop overview', async (req, res) => {
  const [claimsSnap, couponsSnap] = await Promise.all([
    ref(DB_PATHS.AIRDROP_CLAIMS).once('value'),
    ref(DB_PATHS.USER_COUPONS).once('value'),
  ]);
  const claims = claimsSnap.exists() ? claimsSnap.val() : {};
  const couponTree = couponsSnap.exists() ? couponsSnap.val() : {};
  const users = await userMap();
  const weekKey = airdropService.getWeekKey();
  const now = Date.now();

  let totalClaims = 0;
  let claimsThisWeek = 0;
  Object.values(claims).forEach((weeks) => {
    Object.keys(weeks || {}).forEach((wk) => { totalClaims++; if (wk === weekKey) claimsThisWeek++; });
  });

  const coupons = [];
  Object.entries(couponTree).forEach(([uid, list]) => {
    Object.values(list || {}).forEach((c) => {
      const expired = c.status === 'active' && c.expiresAt && now > c.expiresAt;
      coupons.push({ ...c, uid, status: expired ? 'expired' : c.status, userEmail: users[uid]?.email || '', userName: users[uid]?.displayName || users[uid]?.name || '' });
    });
  });
  coupons.sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));

  const byPercent = {};
  coupons.forEach((c) => { byPercent[c.discountPercent] = (byPercent[c.discountPercent] || 0) + 1; });
  const stats = {
    weekKey, claimsThisWeek, totalClaims,
    issued: coupons.length,
    active: coupons.filter((c) => c.status === 'active').length,
    used: coupons.filter((c) => c.status === 'used').length,
    expired: coupons.filter((c) => c.status === 'expired').length,
    revoked: coupons.filter((c) => c.status === 'revoked').length,
    byPercent,
  };
  return response.success(res, 'Airdrop overview fetched', { stats, coupons: coupons.slice(0, 100) });
});

// POST /api/admin/airdrop/grant  { email | uid, discountPercent, validityDays }
const airdropGrant = wrap('Admin airdrop grant', async (req, res) => {
  const { email, uid, discountPercent, validityDays } = req.body || {};
  const users = await firebaseService.getAllUsers();
  const target = uid
    ? users.find((u) => u.uid === uid)
    : users.find((u) => String(u.email || '').toLowerCase() === String(email || '').trim().toLowerCase());
  if (!target) return response.error(res, 'No user found with that email.', 404);
  let coupon;
  try {
    coupon = await airdropService.adminGrantCoupon(target.uid, discountPercent, validityDays);
  } catch (e) {
    return response.error(res, e.message, 400);
  }
  notificationService.createNotification(target.uid, {
    title: 'You received a coupon!',
    message: `${coupon.discountPercent}% off your next subscription is waiting in My Coupons. Valid for ${validityDays} days.`,
  }).catch(() => {});
  audit(req, 'ADMIN_COUPON_GRANTED', { toUid: target.uid, couponId: coupon.id, discountPercent: coupon.discountPercent });
  return response.success(res, 'Coupon granted', { coupon: { ...coupon, uid: target.uid, userEmail: target.email } }, 201);
});

// POST /api/admin/airdrop/revoke  { uid, couponId }
const airdropRevoke = wrap('Admin airdrop revoke', async (req, res) => {
  const { uid, couponId } = req.body || {};
  if (!uid || !couponId) return response.error(res, 'uid and couponId are required.');
  try {
    await airdropService.adminRevokeCoupon(uid, couponId);
  } catch (e) {
    return response.error(res, e.message, 400);
  }
  audit(req, 'ADMIN_COUPON_REVOKED', { uid, couponId });
  return response.success(res, 'Coupon revoked');
});

module.exports = { listStaff, setStaffStatus, forceStaffLogout, removeStaff, listMerchantPromos, toggleMerchantPromo, deleteMerchantPromo, airdropOverview, airdropGrant, airdropRevoke };
