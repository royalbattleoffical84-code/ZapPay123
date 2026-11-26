// controllers/merchantPromoController.js
const promoSvc = require('../services/merchantPromoService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof promoSvc.PromoError) return response.error(res, err.message, err.status, err.extra);
    logger.error(`Merchant promo controller error: ${err.stack || err.message}`);
    return response.serverError(res, 'Something went wrong. Please try again.');
  }
};

const actorOf = (req) => (req.user.staff ? `staff:${req.user.staff.name}` : 'owner');

/* ── merchant (owner, or staff with the "promo" permission) ── */
const list = wrap(async (req, res) => {
  const promos = await promoSvc.listPromos(req.user.uid);
  return response.success(res, 'Promo codes fetched', { promos, max: promoSvc.MAX_PROMOS_PER_MERCHANT, suggestion: promoSvc.generateCode() });
});

const create = wrap(async (req, res) => {
  const promo = await promoSvc.createPromo(req.user.uid, req.body || {}, actorOf(req));
  return response.success(res, 'Promo code created', { promo }, 201);
});

const update = wrap(async (req, res) => {
  const promo = await promoSvc.updatePromo(req.user.uid, req.params.code, req.body || {});
  return response.success(res, 'Promo code updated', { promo });
});

const remove = wrap(async (req, res) => {
  await promoSvc.deletePromo(req.user.uid, req.params.code);
  return response.success(res, 'Promo code deleted');
});

const redemptions = wrap(async (req, res) => {
  const rows = await promoSvc.listRedemptions(req.user.uid, req.params.code);
  return response.success(res, 'Redemptions fetched', { redemptions: rows });
});

/* ── customer (public, from the checkout page) ── */
const publicInfo = wrap(async (req, res) => {
  const info = await promoSvc.orderInfo(req.params.orderId);
  return response.success(res, 'OK', info);
});

const publicApply = wrap(async (req, res) => {
  const { orderId, code } = req.body || {};
  const result = await promoSvc.applyToOrder(orderId, code);
  return response.success(res, result.alreadyApplied ? 'Promo code already applied' : 'Promo code applied', result.applied);
});

const publicRemove = wrap(async (req, res) => {
  const result = await promoSvc.removeFromOrder((req.body || {}).orderId);
  return response.success(res, result.removed ? 'Promo code removed' : 'No promo code was applied', { amount: result.amount });
});

module.exports = { list, create, update, remove, redemptions, publicInfo, publicApply, publicRemove };
