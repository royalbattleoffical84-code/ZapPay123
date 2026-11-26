// utils/checkoutUrlBuilder.js
//
// Single source of truth for building a customer-facing checkout URL.
// Previously this logic (theme/color query params, base URL) was
// duplicated inline at 6 separate call sites across
// paymentLinkController.js and developerController.js — any new
// customization option (like hideIntent, storeLogoUrl, merchantDisplayName
// below) had to be copy-pasted into all 6 to actually take effect
// everywhere. Centralizing it means a merchant's checkout customizations
// apply consistently regardless of which flow (payment link, ZapAPI
// order, cashier-routed, wallet-routed) generated the checkout.

/**
 * @param {object} merchantUser - the merchant's user record (for
 *   checkoutTheme, checkoutThemeColor, hideIntent, storeLogoUrl,
 *   merchantDisplayName)
 * @param {object} params - { orderId, amount, upiId, redirectUrl, method }
 *   method is optional — only set for Paytm-routed orders, matches the
 *   existing &method=paytm param checkout.html/check.html already read
 *   to relabel the third quick-pay button.
 * @returns {string} the full checkout URL
 */
function buildCheckoutUrl(merchantUser, { orderId, amount, upiId, redirectUrl, method, testMode, timeoutSec }) {
  // Checkout Page now offers exactly 3 themes — zenith, aurora-x, prism —
  // each a dedicated FILE (check.html/check2.html/check3.html), not a
  // CSS-only theme. checkout.html (the old static QR+buttons template)
  // and every CSS-only theme that used to live there (default, nova,
  // ember, emerald, aurora, obsidian) are retired for Checkout Page —
  // ANY of those old values, or anything else unrecognized, falls back
  // to zenith, which is also the platform default going forward.
  const rawTheme = merchantUser?.checkoutTheme;
  const theme = ['zenith', 'aurora-x', 'prism'].includes(rawTheme) ? rawTheme : 'zenith';

  const checkoutFile =
    theme === 'aurora-x' ? 'check2.html' :
    theme === 'prism'    ? 'check3.html' :
    'check.html';

  const STORE_BASE = (process.env.STORE_URL || 'https://YOUR-DOMAIN.com').trim().replace(/\/+$/, '');
  let url = `${STORE_BASE}/${checkoutFile}?order_id=${orderId}&amount=${amount}&upi=${encodeURIComponent(upiId)}&redirect_url=${encodeURIComponent(redirectUrl)}`;
  url += `&theme=${encodeURIComponent(theme)}`;
  if (merchantUser?.checkoutThemeColor) url += `&color=${encodeURIComponent(merchantUser.checkoutThemeColor)}`;
  // Hide Intent UPI Button: ON by default (checkout pages hide the UPI app
  // list unless told otherwise) — only an explicit false sends hide_intent=0.
  if (merchantUser?.hideIntent === false) url += `&hide_intent=0`;
  if (merchantUser?.storeLogoUrl) url += `&logo=${encodeURIComponent(merchantUser.storeLogoUrl)}`;
  if (merchantUser?.merchantDisplayName) url += `&mname=${encodeURIComponent(merchantUser.merchantDisplayName)}`;
  if (method) url += `&method=${encodeURIComponent(method)}`;
  // Checkout-page countdown timer duration, in seconds. Driven by Admin
  // Settings -> "Amount + Time Verification Mode" (3 min when ON, 8 min
  // default when OFF — see config/constants.js VERIFICATION_TIMEOUT_MS).
  // Every call site passes this explicitly (computed from the same
  // `settings` object it already fetches for order creation) rather than
  // defaulting here, so the window check.html/check2.html/check3.html
  // actually count down never drifts out of sync with the window
  // fampayService.js enforces server-side. check*.html fall back to 480
  // if this param is ever missing (e.g. an old cached checkout link).
  if (timeoutSec) url += `&timeout_sec=${encodeURIComponent(timeoutSec)}`;
  // Test Mode (ZapAPI orders only) — the SAME checkout page the merchant
  // picked on the Customize Page opens, with a floating flask button in
  // its bottom-right corner (see each check*.html's TEST MODE FAB block)
  // that simulates a payment result against POST /api/gateway-test/
  // :orderId/simulate. Replaces sending the customer to the separate
  // test.html page for ZapAPI orders.
  if (testMode) url += `&test_mode=1`;

  return url;
}

module.exports = { buildCheckoutUrl };
