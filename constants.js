// config/constants.js - Application Constants

module.exports = {
  ROLES: {
    USER: 'user',
    ADMIN: 'admin',
  },

  PAYMENT_STATUS: {
    PENDING: 'pending',
    SUCCESS: 'success',
    FAILED: 'failed',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled',
    // Amount+Time mode only (see fampayService.verifyPayment): more than
    // one pending order matched the same amount within the same payment's
    // valid window and the correct one could not be determined
    // deterministically. Never auto-resolved — stays available for manual
    // UTR entry (checkUtrForOrder still runs normally against it) and for
    // the next poll, since a sibling order finishing first can resolve the
    // ambiguity on its own.
    AMBIGUOUS: 'ambiguous',
  },

  // Verification method recorded on a payment / verification log entry —
  // see VERIFICATION_TIMEOUT_MS below and fampayService.js for where each
  // is produced.
  VERIFICATION_METHOD: {
    AUTO_PURPOSE: 'AUTO_PURPOSE',       // Normal Mode auto-match (amount + time, Note/Purpose used as a corroborating signal)
    AUTO_AMOUNT_TIME: 'AUTO_AMOUNT_TIME', // Amount + Time Mode auto-match (Note/Purpose never consulted)
    MANUAL_UTR: 'MANUAL_UTR',           // User-submitted UTR/Txn ID, verified against the mailbox record
  },

  // Order payment-window (checkout timer) duration per verification mode.
  // Toggled centrally by Admin Settings -> "Amount + Time Verification
  // Mode" (settings.amountTimeVerificationMode) rather than hard-coded at
  // each call site — see utils/checkoutUrlBuilder.js (frontend countdown)
  // and services/fampayService.js (server-side auto-verify window).
  VERIFICATION_TIMEOUT_MS: {
    NORMAL: 8 * 60 * 1000,      // Normal Mode (Note/Purpose-era default) — unchanged
    AMOUNT_TIME: 3 * 60 * 1000, // Amount + Time Mode — tighter window since Note/Purpose can no longer disambiguate
  },

  WITHDRAWAL_STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
  },

  PAYMENT_LINK_STATUS: {
    ACTIVE: 'active',
    EXPIRED: 'expired',
    DISABLED: 'disabled',
  },

  SUBSCRIPTION_STATUS: {
    ACTIVE: 'active',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
  },

  // Multi-month subscription discount tiers. `months` multiplies a plan's
  // monthly `price`; `discountPercent` is then taken off that total. This
  // is the ONLY place these numbers live — subscriptionService reads it
  // to price every purchase server-side, and the frontend fetches it via
  // GET /subscription/duration-options so both always agree.
  SUBSCRIPTION_DURATIONS: [
    { months: 1,  discountPercent: 0  },
    { months: 3,  discountPercent: 2  },
    { months: 6,  discountPercent: 5  },
    { months: 12, discountPercent: 12 },
    { months: 24, discountPercent: 25 },
  ],

  // How many staff accounts a merchant may create, per plan. Blaze (free)
  // = 0 → Staff Management is locked. A plan document in the database may
  // override this with its own numeric `staffLimit` field.
  STAFF_LIMITS_BY_PLAN: {
    blaze: 0,
    bronze: 2,
    silver: 5,
    gold: 10,
    developer: 25,
    business: 50,
  },

  NOTIFICATION_TYPE: {
    PAYMENT: 'payment',
    WITHDRAWAL: 'withdrawal',
    GENERAL: 'general',
    SYSTEM: 'system',
    SUBSCRIPTION: 'subscription',
    SECURITY: 'security',
    ADMIN_NOTICE: 'admin_notice',
  },

  DB_PATHS: {
    USERS: 'users',
    PAYMENTS: 'payments',
    WITHDRAWALS: 'withdrawals',
    NOTIFICATIONS: 'notifications',
    SETTINGS: 'settings',
    PROCESSED_ORDERS: 'processedOrders',
    ACTIVITY_LOGS: 'activityLogs',
    PLANS: 'plans',
    USER_SUBSCRIPTIONS: 'userSubscriptions',
    PAYMENT_LINKS: 'paymentLinks',
    COMMISSION_LOGS: 'commissionLogs',
    REFERRALS: 'referrals',
    REFERRAL_CODES: 'referralCodes',
    PROMO_CODES: 'promoCodes',
    PROMO_REDEMPTIONS: 'promoRedemptions',
    SUPPORT_MESSAGES: 'supportMessages',
    SUPPORT_THREADS: 'supportThreads',
    API_TOKENS: 'apiTokens', // ZapAPI key -> uid reverse-lookup index (Developer Portal)
    STORES: 'stores', // per-user store settings + products (Store Portal)
    STORE_ID_INDEX: 'storeIdIndex', // public storeId -> uid reverse-lookup index (store.html)
    STAFF: 'staff', // staff/{ownerUid}/{staffId} — sub-accounts a merchant creates (Management → Staff)
    STAFF_INDEX: 'staffIndex', // staffIndex/{username} -> { ownerUid, staffId } (login lookup + unique usernames)
    MERCHANT_PROMOS: 'merchantPromos', // merchantPromos/{ownerUid}/{CODE} — promo codes a merchant gives THEIR customers
    MERCHANT_PROMO_REDEMPTIONS: 'merchantPromoRedemptions', // .../{ownerUid}/{CODE}/{orderId} — paid redemptions
    EMAIL_OTPS: 'emailOtps', // emailOtps/<purpose>/<email> -> { hash, expiresAt, attempts } for /api/otp
    WEBHOOKS: 'webhooks', // webhooks/<uid>/<webhookId> -> { url, isActive, createdAt, lastTriggeredAt, lastStatus }
    AGENT_CONVERSATIONS: 'agentConversations', // agentConversations/<uid>/<conversationId> -> { title, createdAt, updatedAt, messages: [...] }
    REWARD_SUBMISSIONS: 'rewardSubmissions', // rewardSubmissions/<id> -> { userId, type: 'video'|'bug', title, videoLink|images[], description, status, adminComment, reward, createdAt, resolvedAt, resolvedByUid }
    USER_COUPONS: 'userCoupons', // userCoupons/<uid>/<couponId> -> { discountPercent, source, status: 'unused'|'saved'|'used', grantedAt, expiresAt, usedAt, usedOnOrderId }
    AIRDROP_CLAIMS: 'airdropClaims', // airdropClaims/<uid>/<weekKey> -> { claimedAt, discountPercent, couponId } — one claim per ISO week per user
    // verificationLogs/<pushId> -> { orderId, amount, paymentTime, utrMasked,
    // verificationMethod, verificationMode, result, reason, processingTimeMs,
    // createdAt }. Deliberately NEVER contains: user email, IMAP
    // credentials, raw email body/subject, or unmasked UTR — see the
    // privacy note in fampayService.js's logVerificationAttempt().
    VERIFICATION_LOGS: 'verificationLogs',
  },

  // Quick-pick reasons shown to admin when banning a user (also usable as-is as
  // the message the banned user sees). Admin can still type a custom reason.
  BAN_REASON_TEMPLATES: [
    'Your account has been suspended due to detected scamming or fraudulent activity.',
    'Your account has been suspended due to multiple user complaints against you.',
    'Your account has been suspended for suspicious or illegal activity on the platform.',
    'Your account has been suspended for violating our Terms & Conditions.',
    'Your account has been suspended for using the platform to facilitate gambling or betting transactions.',
  ],

  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',

  ZAP_API_URL: process.env.ZAP_API_URL || 'https://pay.zapupi.com/api',

  // Zap Credit — one-time signup grant for every user (new signups get it
  // immediately; existing users are backfilled once on next login)
  ZAP_CREDIT_SIGNUP_GRANT: 50,
  ZAP_CREDIT_LOW_BALANCE_THRESHOLD: 10,

  DEFAULT_SETTINGS: {
    minWithdrawal: 100,
    commissionPercent: 5,
    maintenanceMode: false,
    siteName: 'ZapPay',
    supportEmail: 'support@YOUR-DOMAIN.com',
    // Agentic Support — admin on/off switch + which underlying model each
    // of ZPP-X / ZPP-Y actually calls. When agenticSupportEnabled is false,
    // the ENTIRE Agentic Support section is hidden everywhere in the panel
    // (sidebar item, Support page's promo card, and /agent.html itself —
    // see routes/user.js's getPublicConfig and agent.html's own guard).
    // Model fields default to null, meaning "use the env var" (see
    // services/agentService.js's getModelConfig) — set here only to
    // override without a redeploy.
    agenticSupportEnabled: true,
    zppXPrimaryModel: null,
    zppXFallbackModel: null,
    zppYPrimaryModel: null,
    zppYFallbackModel: null,
    systemRoutingMode: 'zapupi', // 'zapupi' or 'self' (ADDED FOR ADMIN CASHIER)
    systemRoutingAdminUid: null, // (ADDED FOR ADMIN CASHIER)
    // Hide Wallet System — when true, the platform stops acting as a
    // pass-through for third-party funds: Zap Cash can no longer be
    // topped up (existing balance can still be spent/withdrawn), and
    // merchants must connect their own cashier (FamPay/Paytm) before
    // their payment links or ZapAPI can accept money at all. See
    // controllers/paymentLinkController.js, developerController.js, and
    // walletController.js for the enforcement points.
    hideWalletSystemEnabled: false,
    // Amount + Time Verification Mode — added because FamPay stopped
    // including Note/Purpose in its payment-alert emails, which the
    // original IMAP verifier relied on as its primary match signal.
    // OFF (default): Normal Mode — 8-minute order timeout; automatic
    //   verification is amount + payment time, with Note/Purpose (when
    //   present) used as an extra corroborating check, exactly as
    //   before. This is the original behavior and stays the default so
    //   nothing changes for merchants until they opt in.
    // ON: Amount + Time Mode — 3-minute order timeout; Note/Purpose is
    //   never consulted; automatic verification is amount + payment
    //   time only, with stricter window enforcement (payment must land
    //   within the 3-minute window, not just after order-creation) and
    //   an ambiguous-match guard (see fampayService.js). Manual UTR
    //   verification remains available in both modes.
    // See services/fampayService.js and config/constants.js's
    // VERIFICATION_TIMEOUT_MS / VERIFICATION_METHOD for the actual
    // enforcement — this flag is the single on/off switch for both.
    amountTimeVerificationMode: false,
    minZapCreditPurchase: 25, // smallest amount a user may add to Zap Credit in one go (via convert-from-cash OR direct UPI recharge — both enforce this same setting)
    fampayInviteLink: 'https://get.fampay.in/SOVIOEMTW-100P', // shown as "Download FamPay from Playstore" on the FamPay Connect page
    // imgbb API key — powers the store-logo upload on the Customize page
    // (zenith theme only): merchant picks an image from their gallery,
    // panel uploads it to imgbb using this key, imgbb returns a hosted
    // URL, that URL is what actually gets saved as storeLogoUrl. Editable
    // here so the key can be rotated without a code deploy if it's ever
    // revoked/rate-limited.
    imgbbApiKey: '0f270edf1ce1f0a091cbd5acf6b4ab4d',
    // Referral program
    signupBonus: 100,                   
    referralCommissionPercent: 25,      
    referralQualifyingMinDeposit: 100,  
    signupZapCredit: 50,                
    // Social / contact links
    socialLinks: {
      telegram:  { url: '', enabled: false },
      instagram: { url: '', enabled: false },
      youtube:   { url: '', enabled: false },
      whatsapp:  { url: '', enabled: false },
    },
  },

  // Default promo codes
  DEFAULT_PROMO_CODES: {
    WELCM5: {
      code: 'WELCM5',
      type: 'fixed',
      value: 5,
      maxUses: -1,
      usedCount: 0,
      perUserLimit: 1,
      isActive: true,
      description: 'Welcome bonus — ₹5 Zap Bonus credit',
      createdAt: Date.now(),
    },
  },

  // Default plans
  DEFAULT_PLANS: {
    blaze: {
      id: 'blaze',
      name: '⚡ Blaze',
      badge: 'Free',
      price: 0,
      walletLimit: 500,
      paymentLinksPerMonth: 100,
      linkExpiryDays: 7,
      commissionPercent: 5,
      withdrawalCount: 1,
      withdrawalPeriod: 'week',
      webhookLimit: 3,
      features: ['100 Payment Links/month', '7 Day Link Expiry', '₹500 Wallet Limit', '1 Withdrawal/week', '5% Commission', '3 Webhooks', 'Unlock premium themes (Silver+)', 'Free Store Access'],
      isActive: true,
      isHighlighted: false,
      isDefault: true,
      displayOrder: 1,
    },
    bronze: {
      id: 'bronze',
      name: '🥉 Bronze',
      badge: 'Starter',
      price: 29,
      walletLimit: 1000,
      paymentLinksPerMonth: 250,
      linkExpiryDays: 15,
      commissionPercent: 3.5,
      withdrawalCount: 3,
      withdrawalPeriod: 'week',
      webhookLimit: 5,
      features: ['250 Payment Links/month', '15 Day Link Expiry', '₹1,000 Wallet Limit', '3 Withdrawals/week', '3.5% Commission', '5 Webhooks', 'Unlock premium themes (Silver+)', 'Free Store Access'],
      isActive: true,
      isHighlighted: false,
      isDefault: false,
      displayOrder: 2,
    },
    silver: {
      id: 'silver',
      name: '🥈 Silver',
      badge: 'Most Popular',
      price: 59,
      walletLimit: 3000,
      paymentLinksPerMonth: 1000,
      linkExpiryDays: 30,
      commissionPercent: 2,
      withdrawalCount: 1,
      withdrawalPeriod: 'day',
      webhookLimit: 10,
      features: ['1,000 Payment Links/month', '30 Day Link Expiry', '₹3,000 Wallet Limit', '1 Withdrawal/day', '2% Commission', '10 Webhooks', 'Unlock premium themes', 'Free Store Access'],
      isActive: true,
      isHighlighted: true,
      isDefault: false,
      displayOrder: 3,
    },
    gold: {
      id: 'gold',
      name: '🥇 Gold',
      badge: 'Premium',
      price: 149,
      walletLimit: 7500,
      paymentLinksPerMonth: 3000,
      linkExpiryDays: 90,
      commissionPercent: 1,
      withdrawalCount: 3,
      withdrawalPeriod: 'day',
      webhookLimit: 25,
      features: ['3,000 Payment Links/month', '90 Day Link Expiry', '₹7,500 Wallet Limit', '3 Withdrawals/day', '1% Commission', '25 Webhooks', 'Unlock premium themes', 'Free Store Access'],
      isActive: true,
      isHighlighted: false,
      isDefault: false,
      displayOrder: 4,
    },
    developer: {
      id: 'developer',
      name: '👨‍💻 Developer',
      badge: 'Unlimited',
      price: 299,
      walletLimit: 20000,
      paymentLinksPerMonth: -1,
      linkExpiryDays: -1,
      commissionPercent: 0.5,
      withdrawalCount: 10,
      withdrawalPeriod: 'day',
      webhookLimit: -1,
      features: ['Unlimited Payment Links', 'No Link Expiry', '₹20,000 Wallet Limit', '10 Withdrawals/day', '0.5% Commission', 'Unlimited Webhooks', 'Unlock premium themes', 'Free Store Access'],
      isActive: true,
      isHighlighted: false,
      isDefault: false,
      displayOrder: 5,
    },
    business: {
      id: 'business',
      name: '💼 Business',
      badge: 'Everything Unlimited',
      price: 499,
      // NOTE: walletLimit and withdrawalCount can't use this codebase's
      // -1-means-unlimited convention (used elsewhere for
      // paymentLinksPerMonth/linkExpiryDays/webhookLimit) — those two are
      // used in actual arithmetic across 11+ call sites (e.g.
      // `balance >= plan.walletLimit`, `plan.walletLimit - balance`,
      // `withdrawalController`'s per-period count check), where -1 would
      // make every wallet look permanently "full" and break withdrawals
      // entirely instead of unlocking them. A large practical ceiling
      // achieves the same "unlimited in practice" outcome without
      // corrupting that math. paymentLinksPerMonth/linkExpiryDays/
      // webhookLimit ARE safe as -1 — those only ever appear in
      // `=== -1 ? unlimited : count` style checks, never subtracted from.
      walletLimit: 100000000, // ₹10 crore — no real merchant will hit this
      paymentLinksPerMonth: -1,
      linkExpiryDays: -1,
      commissionPercent: 0,
      withdrawalCount: 1000, // per period (see withdrawalPeriod) — effectively unlimited
      withdrawalPeriod: 'day',
      webhookLimit: -1,
      features: ['Unlimited Payment Links', 'No Link Expiry', 'Unlimited Wallet Limit', 'Unlimited Withdrawals', '0% Commission', 'Unlimited Webhooks', 'Unlock premium themes', 'Free Store Access'],
      isActive: true,
      isHighlighted: false,
      isDefault: false,
      displayOrder: 6,
    },
  },
};
