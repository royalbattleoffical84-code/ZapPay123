// routes/user.js
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const firebaseService = require('../services/firebaseService');
const subscriptionService = require('../services/subscriptionService');
const response = require('../helpers/response');
const logger = require('../utils/logger');
const { body, validationResult } = require('express-validator');

router.use(authenticate, blockIfBanned);

// Themes that require Silver plan or above — checked server-side too, not
// just hidden in the UI, since profile updates are a direct API call.
// Payment Link's only theme (Aurora) is Silver+; Checkout Page's three
// (zenith/aurora-x/prism) are all free.
const PREMIUM_THEMES = ['aurora'];
const PREMIUM_PLAN_IDS = ['silver', 'gold', 'developer', 'business'];
// Checkout Page (ZapAPI/order flow, via checkoutUrlBuilder.js): exactly
// 3 dedicated-file themes. checkout.html (the old static template) and
// every CSS-only theme that used to live there (default, nova, ember,
// emerald, obsidian) are retired — not accepted here anymore.
const CHECKOUT_THEMES = ['zenith', 'aurora-x', 'prism'];
// Payment Link (pay.html / link/index.html, via paymentLinkController.js):
// exactly 1 theme. Not really a "choice" anymore — every merchant runs
// Aurora — but still validated explicitly so a stray/legacy value can
// never be saved here by mistake.
const PAYMENT_LINK_THEMES = ['aurora'];

// PUT /api/user/profile
router.put('/profile', blockIfImpersonating, [
  body('displayName').optional().isLength({ max: 60 }).trim().escape(),
  body('phone').optional().matches(/^\d{10}$/).withMessage('Invalid phone number'),
  body('upiId').optional().matches(/^[\w.-]+@[\w.-]+$/).withMessage('Invalid UPI ID'),
  body('upiHolderName').optional({ checkFalsy: true }).isLength({ max: 100 }).trim().escape(),
  body('bankDetails').optional().isObject().withMessage('Invalid bank details'),
  body('bankDetails.accountNumber').optional({ checkFalsy: true }).matches(/^\d{9,18}$/).withMessage('Invalid account number'),
  body('bankDetails.ifscCode').optional({ checkFalsy: true }).matches(/^[A-Z]{4}0[A-Z0-9]{6}$/i).withMessage('Invalid IFSC code'),
  body('bankDetails.accountHolderName').optional({ checkFalsy: true }).isLength({ max: 100 }).trim().escape(),
  // checkoutTheme controls ONLY the ZapAPI/order checkout flow
  // (checkoutUrlBuilder.js's check.html/check2.html/check3.html
  // routing). Payment Links (pay.html / link/index.html, via
  // paymentLinkController.js) have their OWN independent theme —
  // paymentLinkTheme, below — kept as separate settings even though
  // Payment Link is no longer a real "choice" (always Aurora).
  body('checkoutTheme').optional().isIn(CHECKOUT_THEMES).withMessage('Invalid theme'),
  body('paymentLinkTheme').optional().isIn(PAYMENT_LINK_THEMES).withMessage('Invalid theme'),
  body('checkoutThemeColor').optional({ checkFalsy: true }).matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Invalid color — use a hex code'),
  body('paymentLinkThemeColor').optional({ checkFalsy: true }).matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Invalid color — use a hex code'),
  body('showOnboarding').optional().isBoolean().withMessage('Invalid value').toBoolean(),
  // Hide Intent UPI Button: checkout pages don't show the UPI app list
  // (QR only). Defaults to ON; not plan-gated.
  body('hideIntent').optional().isBoolean().withMessage('Invalid value').toBoolean(),
  // Shown top-left on the zenith theme's checkout header in place of the
  // generic store icon — an image URL only (upload happens client-side
  // via the imgbb API, this just stores whatever URL that produced, or
  // one the merchant pastes in directly).
  body('storeLogoUrl').optional({ checkFalsy: true }).isURL().withMessage('Invalid logo URL').isLength({ max: 500 }),
  // Replaces "ZapPay Gateway"/the merchant's account name on the checkout
  // header — purely cosmetic, shown to the merchant's own customers.
  body('merchantDisplayName').optional({ checkFalsy: true }).isLength({ max: 60 }).trim().escape(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Logged at warn (not error) since this is a normal client-input
    // rejection, not a server fault — but we still want the exact
    // field/reason visible in Vercel logs instead of just the generic
    // "Validation failed" message the client sees.
    logger.warn(`PUT /user/profile validation failed for uid=${req.user?.uid}: ${JSON.stringify(errors.array())} | body=${JSON.stringify(req.body)}`);
    return response.error(res, 'Validation failed', 400, errors.array());
  }

  try {
    if (PREMIUM_THEMES.includes(req.body.checkoutTheme) || PREMIUM_THEMES.includes(req.body.paymentLinkTheme)) {
      const sub = await subscriptionService.getUserSubscription(req.user.uid);
      if (!PREMIUM_PLAN_IDS.includes(sub?.plan?.id)) {
        return response.error(res, 'This template needs Silver plan or above.', 403);
      }
    }

    await firebaseService.updateUserProfile(req.user.uid, req.body);
    return response.success(res, 'Profile updated successfully');
  } catch (err) {
    return response.serverError(res, err.message);
  }
});

module.exports = router;
