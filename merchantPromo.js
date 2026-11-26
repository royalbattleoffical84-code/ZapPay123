// routes/merchantPromo.js — Management → Promo Codes
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const { promoLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/merchantPromoController');

// ── Public: the customer's checkout page ──
router.get('/public/order/:orderId', ctrl.publicInfo);
router.post('/public/apply', promoLimiter, ctrl.publicApply);
router.post('/public/remove', promoLimiter, ctrl.publicRemove);

// ── Merchant (staff need the "promo" permission — enforced in authenticate) ──
router.get('/list', authenticate, blockIfBanned, ctrl.list);
router.post('/create', authenticate, blockIfBanned, blockIfImpersonating, ctrl.create);
router.get('/:code/redemptions', authenticate, blockIfBanned, ctrl.redemptions);
router.put('/:code', authenticate, blockIfBanned, blockIfImpersonating, ctrl.update);
router.delete('/:code', authenticate, blockIfBanned, blockIfImpersonating, ctrl.remove);

module.exports = router;
