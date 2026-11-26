// ZapPay backend - SINGLE FILE BUNDLE (auto-generated).
// Isme backend ke saare 94 files andar hi hain, alag folders upload karne ki zaroorat nahi.
// Sirf package.json + ye server.js repo ke root me chahiye.

const __defs = {

// ===== server.js =====
"server.js": function (module, exports, __r) {
// server.js - ZapPay Backend
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

const logger = __r("utils/logger.js");

// Initialize Firebase — errors are logged but don't crash the server
const { initializeFirebase } = __r("firebase/admin.js");
initializeFirebase();

// ── One-time seed of default data (idempotent — skips anything that
// already exists) ──
// IMPORTANT: this must run at MODULE LOAD TIME, not as request middleware.
// It previously ran as an app.use() middleware registered AFTER the 404/
// error handlers below — which made it structurally unreachable: any
// matched API route sends its own response and ends the cycle before
// ever reaching it, and any unmatched route hits notFoundHandler (also
// registered earlier) first. Net effect: it never ran in production at
// all, which is why WELCM5 (added to DEFAULT_PROMO_CODES after the last
// local dev run) was never actually written to the database.
(async () => {
  try {
    const { seedDefaultPlans } = __r("services/subscriptionService.js");
    await seedDefaultPlans();
    const { seedDefaultPromoCodes } = __r("services/promoService.js");
    await seedDefaultPromoCodes();
    logger.info('✅ Default plans & promo codes seed check complete');
  } catch (e) {
    logger.error('Seed error: ' + e.message);
  }
})();

const app = express();

// Vercel's edge network sits in front of this function and adds exactly one
// X-Forwarded-For hop before invoking it. Without telling Express to trust
// that one hop, express-rate-limit (used below) sees the X-Forwarded-For
// header, considers it untrusted, and THROWS a ValidationError on every
// single /api/* request — which crashes the whole serverless function
// (500 FUNCTION_INVOCATION_FAILED). This must be set before the rate
// limiter middleware is registered.
app.set('trust proxy', 1);

// Security
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));

// CORS
// Normalize origins (strip trailing slash, lowercase) so a Vercel env var
// like "https://YOUR-OTHER-DOMAIN.com/" still matches the browser's actual
// Origin header "https://YOUR-OTHER-DOMAIN.com" (browsers never send a trailing
// slash). A mismatch here causes fetch() to fail with a generic, unhelpful
// "Failed to fetch" — the browser hides the real CORS reason from JS.
const normalizeOrigin = (o) => (o || '').trim().toLowerCase().replace(/\/+$/, '');
// "www.YOUR-DOMAIN.com" and "YOUR-DOMAIN.com" are the same site to a visitor, but
// FRONTEND_URL only ever holds one spelling — whichever one a browser's
// Origin header doesn't match gets silently CORS-rejected, which is what
// broke the site when Google indexed/linked the www version but
// FRONTEND_URL only listed the bare domain. Stripping "www." from both
// sides before comparing makes either spelling work regardless of which
// one is actually configured.
const stripWww = (o) => o.replace(/^(https?:\/\/)www\./, '$1');
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(normalizeOrigin)
  : ['*'];

const dashboardCors = cors({
  origin: (origin, cb) => {
    const normalizedOrigin = normalizeOrigin(origin);
    const isAllowed = !origin
      || allowedOrigins.includes('*')
      || allowedOrigins.includes(normalizedOrigin)
      || allowedOrigins.some((a) => stripWww(a) === stripWww(normalizedOrigin));
    if (isAllowed) {
      cb(null, true);
    } else {
      logger.warn(`CORS rejected origin: "${origin}" — allowed: ${JSON.stringify(allowedOrigins)}`);
      cb(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

// ZapAPI (Developer Portal) routes are called directly from a MERCHANT'S
// OWN website/app/server — any origin, not just our own frontend — so
// they get their own fully-open CORS instead of the dashboard's origin
// allowlist. No cookies/credentials ride on this door (auth is the
// zap_api key itself, checked inside the route), so opening the origin
// here doesn't widen the dashboard's own attack surface.
//
// NOTE: only the merchant-key-authenticated endpoints (create-order,
// order-status) belong on this open door. /api/developer/token and
// /token/regenerate are called by OUR OWN dashboard (index.html) using
// the user's JWT in an `Authorization` header — they must go through
// dashboardCors instead, because developerCors's allowedHeaders list
// below doesn't include `Authorization`. Routing them through
// developerCors made the browser's CORS preflight for GET
// /api/developer/token fail (Authorization not allowed), which surfaced
// in the UI as a generic "Network error: Could not connect to the
// backend server" on the Developer Portal page.
const developerCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-ZapAPI-Key'],
});

// /api/gateway-test/* (the test.html simulator's own endpoints) belongs on
// this same open door and for the same reason: test.html can end up
// deployed on either the root domain or the panel subdomain (it's mirrored
// to both — see /test.html), and like create-order/order-status it carries
// no cookies/credentials, so opening its origin doesn't widen the
// dashboard's own attack surface either.
const OPEN_CORS_PATHS = [
  /^\/api\/developer\/create-order/,
  /^\/api\/developer\/order-status\//,
  /^\/api\/developer\/public-order-status\//,
  /^\/api\/gateway-test\//,
  // Store Portal storefront (root/store/index.html) now lives on the root
  // domain (YOUR-DOMAIN.com), not the panel subdomain FRONTEND_URL points at.
  // Same reasoning as gateway-test above: public, no auth, no cookies —
  // opening the origin here doesn't widen the dashboard's own attack
  // surface, and it means the storefront keeps working regardless of what
  // FRONTEND_URL is set to.
  /^\/api\/store-public\//,
  // test.html (root domain, /test.html) calls these directly with no login
  // and no cookies — same reasoning as store-public/gateway-test above.
  // Abuse is bounded by otpSendLimiter/otpVerifyLimiter (per email+IP)
  // rather than by CORS, since CORS only stops *browsers*, not scripts.
  /^\/api\/otp\//,
  // checkout.html (root domain, /checkout.html) polls order status and
  // posts manual UTR verification directly — same situation as
  // store-public/gateway-test/otp above: public, no login, no cookies,
  // and it needs to work regardless of what FRONTEND_URL is set to since
  // checkout.html is served from YOUR-DOMAIN.com, not the panel subdomain.
  // Without this, every fetch() from checkout.html to these two routes
  // was silently CORS-rejected by the browser — surfacing in the UI as
  // "Error connecting to verification server" / a poll that never
  // updates, with no useful reason logged client-side (the browser hides
  // the real CORS error from JS, same as the note at the top of this
  // file describes for the earlier Developer Portal case).
  /^\/api\/payment-link\/order\//,
  // Checkout pages (YOUR-DOMAIN.com) let a customer enter a MERCHANT's promo code —
  // public, no login, no cookies (same situation as the routes above).
  /^\/api\/promo-manager\/public\//,
  /^\/api\/sms\/verify-manual/,
];

app.use((req, res, next) => {
  if (OPEN_CORS_PATHS.some(re => re.test(req.path))) return developerCors(req, res, next);
  return dashboardCors(req, res, next);
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) } }));

// Rate limiting
const { generalLimiter } = __r("middleware/rateLimiter.js");
app.use('/api/', generalLimiter);

// ── Health Check (no Firebase needed) ──
app.get('/', (req, res) => {
  res.json({ name: 'ZapPay API', version: '1.0.0', status: 'running' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ── Routes ──
app.use('/api/config',       __r("routes/config.js"));
app.use('/api/auth',         __r("routes/auth.js"));
app.use('/api/user',         __r("routes/user.js"));
app.use('/api/wallet',       __r("routes/wallet.js"));
app.use('/api/payment',      __r("routes/payment.js"));
app.use('/api/payment-link', __r("routes/paymentLink.js"));
app.use('/api/subscription', __r("routes/subscription.js"));
app.use('/api/withdrawal',   __r("routes/withdrawal.js"));
app.use('/api/notification', __r("routes/notification.js"));
app.use('/api/referral',     __r("routes/referral.js"));
app.use('/api/promo',        __r("routes/promo.js"));
app.use('/api/rewards',      __r("routes/reward.js"));
app.use('/api/airdrop',      __r("routes/airdrop.js"));
app.use('/api/support',      __r("routes/support.js"));
app.use('/api/admin',        __r("routes/admin.js"));
app.use('/api/webhook',      __r("routes/webhook.js"));
app.use('/api/developer',    __r("routes/developer.js"));
app.use('/api/gateway-test', __r("routes/gatewayTest.js"));
app.use('/api/store',        __r("routes/store.js"));
app.use('/api/store-public', __r("routes/storePublic.js"));
app.use('/api/otp',          __r("routes/otp.js"));
app.use('/api/agent',        __r("routes/agent.js"));
app.use('/api/sms',          __r("routes/sms.js"));
app.use('/api/fampay',       __r("routes/fampay.js"));
app.use('/api/paytm',        __r("routes/paytm.js"));
app.use('/api/amazon',       __r("routes/amazon.js"));
app.use('/api/history',      __r("routes/history.js"));
app.use('/api/cron',         __r("routes/cron.js"));
app.use('/api/upload',       __r("routes/upload.js"));
app.use('/api/staff',        __r("routes/staff.js"));
app.use('/api/promo-manager', __r("routes/merchantPromo.js"));


// ── Error Handlers ──
const errorHandler = __r("middleware/errorHandler.js");
app.use(errorHandler.notFoundHandler);
app.use(errorHandler);

// ── Start ──
// For Vercel: module.exports must come before or alongside app.listen
// Vercel uses the exported app directly in serverless mode
const PORT = process.env.PORT || 3000;

// Render (aur local) par server ko khud port par listen karna padta hai.
// Sirf Vercel serverless me listen nahi karte (wahan exported app use hota hai).
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 ZapPay running on port ${PORT}`);
  });
}

module.exports = app;

},

// ===== utils/logger.js =====
"utils/logger.js": function (module, exports, __r) {
// utils/logger.js
const winston = require('winston');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return stack
      ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
      : `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  })
);

// ⚠️ Vercel serverless has NO writable filesystem
// Only use Console transport — no File transports
const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      logFormat
    ),
  }),
];

const logger = winston.createLogger({
  level: 'info',
  transports,
});

module.exports = logger;

},

// ===== firebase/admin.js =====
"firebase/admin.js": function (module, exports, __r) {
// firebase/admin.js
const admin = require('firebase-admin');
const logger = __r("utils/logger.js");

let db;
let initialized = false;

function initializeFirebase() {
  try {
    if (admin.apps.length > 0) {
      db = admin.apps[0].database();
      initialized = true;
      return;
    }

    // ── Private key fix for Vercel ──
    // Vercel sometimes stores \n as literal \\n — both cases handled
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    // Remove surrounding quotes if present
    privateKey = privateKey.replace(/^["']|["']$/g, '');

    if (!privateKey || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID) {
      throw new Error(
        'Missing Firebase env vars. Check: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY'
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: privateKey,
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });

    db = admin.database();
    initialized = true;
    logger.info('✅ Firebase Admin SDK initialized');

  } catch (error) {
    // ⚠️ Do NOT call process.exit() — it crashes Vercel serverless functions
    logger.error('❌ Firebase initialization failed: ' + error.message);
    logger.error('Fix: Check your Firebase environment variables in Vercel Dashboard');
    // Let the app start but DB calls will fail gracefully
  }
}

function getAuth() {
  return admin.auth();
}

function getDatabase() {
  if (!db) {
    throw new Error('Firebase not initialized. Check environment variables in Vercel Dashboard.');
  }
  return db;
}

function ref(path) {
  return getDatabase().ref(path);
}

function serverTimestamp() {
  return admin.database.ServerValue.TIMESTAMP;
}

module.exports = {
  initializeFirebase,
  getAuth,
  getDatabase,
  ref,
  serverTimestamp,
  admin,
};

},

// ===== services/subscriptionService.js =====
"services/subscriptionService.js": function (module, exports, __r) {
// services/subscriptionService.js
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS, DEFAULT_PLANS, SUBSCRIPTION_DURATIONS } = __r("config/constants.js");
const walletService = __r("services/walletService.js");
const logger = __r("utils/logger.js");

/**
 * The duration/discount tiers available on every plan's purchase flow.
 */
function getDurationOptions() {
  return SUBSCRIPTION_DURATIONS;
}

// Backfills any field missing on a DB-stored plan record with the value
// from DEFAULT_PLANS. Needed because DEFAULT_PLANS has since gained
// fields (webhookLimit, updated feature copy) that older seeded DB
// records never received — the DB always wins verbatim over
// DEFAULT_PLANS without this, so a plan missing webhookLimit would show
// "undefined webhooks" on the frontend, and could feed the literal string
// 'undefined' into a payment remark sent to the UPI gateway (which then
// rejects it as an invalid remark).
function withPlanDefaults(plan) {
  if (!plan) return plan;
  const defaults = DEFAULT_PLANS[plan.id] || {};
  return { ...defaults, ...plan };
}

/**
 * Price breakdown for a plan at a chosen duration. This is the ONLY place
 * that decides what a multi-month purchase actually costs — purchasePlan
 * and purchasePlanWithWallet always recompute from planId + months here
 * instead of trusting any amount the client sends, so a tampered request
 * can never buy a discount it wasn't actually offered.
 * Returns null if `months` isn't one of the configured tiers.
 */
function calculateDurationPrice(monthlyPrice, months) {
  const option = SUBSCRIPTION_DURATIONS.find(d => d.months === Number(months));
  if (!option) return null;
  const basePrice      = Math.round(monthlyPrice * option.months * 100) / 100;
  const discountAmount = Math.round(basePrice * option.discountPercent / 100 * 100) / 100;
  const finalPrice     = Math.round((basePrice - discountAmount) * 100) / 100;
  return {
    months: option.months,
    discountPercent: option.discountPercent,
    basePrice,
    discountAmount,
    finalPrice,
    durationDays: option.months * 30,
  };
}

/**
 * Seed default plans into Firebase ONLY if they don't already exist.
 * Backend will NEVER overwrite existing admin-edited values.
 */
async function seedDefaultPlans() {
  for (const plan of Object.values(DEFAULT_PLANS)) {
    const planRef = ref(`${DB_PATHS.PLANS}/${plan.id}`);
    const snap = await planRef.once('value');
    if (!snap.exists()) {
      await planRef.set({ ...plan, createdAt: Date.now() });
      logger.info(`✅ Seeded missing plan: ${plan.id}`);
    }
  }
}

/**
 * Get all active plans ordered by displayOrder
 */
async function getAllPlans() {
  const snap = await ref(DB_PATHS.PLANS).orderByChild('displayOrder').once('value');
  if (!snap.exists()) return [];
  const plans = [];
  snap.forEach((child) => {
    const plan = child.val();
    if (plan.isActive !== false) plans.push(withPlanDefaults({ id: child.key, ...plan }));
  });
  return plans;
}

/**
 * Get all plans including inactive (admin only)
 */
async function getAllPlansAdmin() {
  const snap = await ref(DB_PATHS.PLANS).orderByChild('displayOrder').once('value');
  if (!snap.exists()) return [];
  const plans = [];
  snap.forEach((child) => plans.push(withPlanDefaults({ id: child.key, ...child.val() })));
  return plans.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
}

/**
 * Get a specific plan by ID
 */
async function getPlan(planId) {
  const snap = await ref(`${DB_PATHS.PLANS}/${planId}`).once('value');
  if (!snap.exists()) return null;
  return withPlanDefaults({ id: planId, ...snap.val() });
}

/**
 * Get user's current subscription (with plan details)
 * Falls back to Blaze (free) plan if no subscription
 */
async function getUserSubscription(userId) {
  const snap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');

  if (!snap.exists()) {
    // Assign Blaze plan
    return await assignFreePlan(userId);
  }

  const sub = snap.val();

  // Check if paid subscription has expired
  if (sub.planId !== 'blaze' && sub.endDate && Date.now() > sub.endDate) {
    logger.info(`Subscription expired for ${userId}, reverting to Blaze`);
    return await assignFreePlan(userId);
  }

  // Attach full plan details
  const plan = await getPlan(sub.planId) || DEFAULT_PLANS[sub.planId] || DEFAULT_PLANS.blaze;
  return { ...sub, plan };
}

/**
 * Has this user ever completed a successful payment for this exact plan
 * before? Used so that switching BACK to a plan already paid for earlier
 * (e.g. bought Bronze, upgraded to Developer, now switching back down to
 * Bronze) doesn't charge them a second time for it — they already own it.
 * Free (Blaze) is always "already owned" since it costs nothing.
 *
 * Reads PAYMENTS records for this user — createPayment() already writes
 * type='subscription' + planId + status on every subscription order, so
 * no new data model is needed.
 */
async function hasUserPaidForPlan(userId, planId) {
  if (planId === 'blaze') return true;
  const snap = await ref(DB_PATHS.PAYMENTS).orderByChild('userId').equalTo(userId).once('value');
  if (!snap.exists()) return false;
  let found = false;
  snap.forEach((child) => {
    const p = child.val();
    if (p.type === 'subscription' && p.planId === planId && p.status === 'success') found = true;
  });
  return found;
}

/**
 * Assign free Blaze plan to user
 */
async function assignFreePlan(userId) {
  const blazePlan = await getPlan('blaze') || DEFAULT_PLANS.blaze;
  const sub = {
    planId: 'blaze',
    planName: blazePlan.name,
    status: 'active',
    startDate: Date.now(),
    endDate: null,        // Free plan never expires
    price: 0,
    paymentLinksUsedThisMonth: 0,
    monthResetDate: getNextMonthReset(),
    withdrawalsThisWeek: 0,
    withdrawalsToday: 0,
    weekResetDate: getNextWeekReset(),
    dayResetDate: getNextDayReset(),
    updatedAt: Date.now(),
  };
  await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).set(sub);
  // If they were on a higher-limit plan and had a balance that fit THAT
  // plan but not Blaze's ₹500 limit, push the excess into Over Balance
  // rather than just leaving `balance` over the new (lower) cap.
  try { await walletService.enforceWalletCap(userId, blazePlan.walletLimit); } catch (e) { logger.error('enforceWalletCap on downgrade failed: ' + e.message); }
  return { ...sub, plan: blazePlan };
}

/**
 * Upgrade user to a paid plan (called after admin manually activates,
 * or after payment verification for subscription purchase)
 */
async function activateSubscription(userId, planId, durationDays = 30) {
  const plan = await getPlan(planId) || DEFAULT_PLANS[planId];
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const now = Date.now();
  const endDate = durationDays > 0 ? now + durationDays * 24 * 60 * 60 * 1000 : null;

  const sub = {
    planId: plan.id,
    planName: plan.name,
    status: 'active',
    startDate: now,
    endDate,
    price: plan.price,
    paymentLinksUsedThisMonth: 0,
    monthResetDate: getNextMonthReset(),
    withdrawalsThisWeek: 0,
    withdrawalsToday: 0,
    weekResetDate: getNextWeekReset(),
    dayResetDate: getNextDayReset(),
    updatedAt: now,
  };

  await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).set(sub);
  logger.info(`Subscription activated: User=${userId}, Plan=${planId}`);
  return { ...sub, plan };
}

/**
 * AUTO-UPGRADE
 * Stored on the USER record (not the subscription doc) since
 * activateSubscription/assignFreePlan both fully overwrite the
 * subscription doc — storing it there would wipe the preference on the
 * very upgrade it's meant to trigger.
 */
async function setAutoUpgradePreference(userId, planId) {
  if (planId) {
    await ref(`${DB_PATHS.USERS}/${userId}/autoUpgradePlanId`).set(planId);
  } else {
    await ref(`${DB_PATHS.USERS}/${userId}/autoUpgradePlanId`).remove();
  }
}

/**
 * Called after any wallet credit (real payment, admin adjustment) —
 * if the user has an auto-upgrade target set and their Zap Cash now
 * covers that plan's price, silently completes the upgrade for them.
 * Mirrors the wallet-purchase path in subscriptionController.js.
 */
async function maybeAutoUpgrade(userId) {
  const prefSnap = await ref(`${DB_PATHS.USERS}/${userId}/autoUpgradePlanId`).once('value');
  const targetPlanId = prefSnap.val();
  if (!targetPlanId) return null;

  const plan = await getPlan(targetPlanId) || DEFAULT_PLANS[targetPlanId];
  if (!plan || plan.price <= 0) { await setAutoUpgradePreference(userId, null); return null; }

  const balance = await walletService.getBalance(userId);
  if (balance < plan.price) return null; // not yet — leave the preference in place

  try {
    await walletService.debitWallet(userId, plan.price, `Auto-upgrade: ${plan.name}`);
  } catch (e) {
    return null; // race with something else that spent the balance first — try again next credit
  }

  const sub = await activateSubscription(userId, targetPlanId, 30);
  await walletService.enforceWalletCap(userId, plan.walletLimit); // pull back any Over Balance that now fits
  await setAutoUpgradePreference(userId, null); // one-shot — clear once fulfilled

  const notificationService = __r("services/notificationService.js");
  await notificationService.createNotification(userId, {
    title: `🚀 Auto-Upgraded to ${plan.name}!`,
    message: `₹${plan.price} was automatically deducted from your Zap Cash and your ${plan.name} plan is now active for 30 days.`,
    type: 'subscription',
  });

  logger.info(`Auto-upgrade completed: User=${userId}, Plan=${targetPlanId}`);
  return sub;
}

/**
 * Check and reset monthly link count if month has passed
 */
async function checkAndResetMonthlyLinks(userId) {
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  if (!snap.exists()) return;

  const sub = snap.val();
  if (Date.now() > (sub.monthResetDate || 0)) {
    await subRef.update({
      paymentLinksUsedThisMonth: 0,
      monthResetDate: getNextMonthReset(),
    });
  }
}

/**
 * Increment payment link count for user
 * (same .transaction() reliability fix as walletService — see notes there)
 */
async function incrementLinkCount(userId) {
  await checkAndResetMonthlyLinks(userId);
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val();
  if (!sub) return;
  await subRef.update({ paymentLinksUsedThisMonth: (sub.paymentLinksUsedThisMonth || 0) + 1 });
}

/**
 * Decrement payment link count for user — called when a link is
 * permanently deleted, freeing up that slot in their monthly quota.
 * Deliberately does NOT call checkAndResetMonthlyLinks first (unlike
 * increment) — deleting a link should never trigger a fresh counting
 * period; it should just reduce whatever the current count already is.
 * Floored at 0 so it can never go negative (e.g. if the month already
 * reset between creating and deleting the link).
 */
async function decrementLinkCount(userId) {
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val();
  if (!sub) return;
  const next = Math.max(0, (sub.paymentLinksUsedThisMonth || 0) - 1);
  await subRef.update({ paymentLinksUsedThisMonth: next });
}

/**
 * Check withdrawal limits based on plan
 */
async function checkWithdrawalLimit(userId, plan) {
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val() || {};

  const period = plan.withdrawalPeriod || 'week';
  const maxCount = plan.withdrawalCount || 1;

  let usedCount, resetDate, resetKey, usedKey;

  if (period === 'day') {
    usedCount = sub.withdrawalsToday || 0;
    resetDate = sub.dayResetDate || 0;
    usedKey = 'withdrawalsToday';
    resetKey = 'dayResetDate';
    const isExpired = Date.now() > resetDate;
    if (isExpired) { usedCount = 0; }
  } else {
    usedCount = sub.withdrawalsThisWeek || 0;
    resetDate = sub.weekResetDate || 0;
    usedKey = 'withdrawalsThisWeek';
    resetKey = 'weekResetDate';
    const isExpired = Date.now() > resetDate;
    if (isExpired) { usedCount = 0; }
  }

  return {
    allowed: usedCount < maxCount,
    used: usedCount,
    max: maxCount,
    period,
    usedKey,
    resetKey,
  };
}

/**
 * Increment withdrawal count after successful submission
 */
async function incrementWithdrawalCount(userId, plan) {
  const info = await checkWithdrawalLimit(userId, plan);
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val() || {};
  const period = plan.withdrawalPeriod || 'week';

  const update = {};
  if (period === 'day') {
    const isExpired = Date.now() > (sub.dayResetDate || 0);
    update.withdrawalsToday = isExpired ? 1 : (sub.withdrawalsToday || 0) + 1;
    if (isExpired) update.dayResetDate = getNextDayReset();
  } else {
    const isExpired = Date.now() > (sub.weekResetDate || 0);
    update.withdrawalsThisWeek = isExpired ? 1 : (sub.withdrawalsThisWeek || 0) + 1;
    if (isExpired) update.weekResetDate = getNextWeekReset();
  }

  await subRef.update(update);
}

// ── Date helpers ──
function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getNextWeekReset() {
  const d = new Date();
  d.setDate(d.getDate() + (7 - d.getDay()));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getNextDayReset() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = {
  seedDefaultPlans,
  getAllPlans,
  getAllPlansAdmin,
  getPlan,
  getUserSubscription,
  hasUserPaidForPlan,
  getDurationOptions,
  calculateDurationPrice,
  assignFreePlan,
  activateSubscription,
  checkAndResetMonthlyLinks,
  incrementLinkCount,
  decrementLinkCount,
  checkWithdrawalLimit,
  incrementWithdrawalCount,
  setAutoUpgradePreference,
  maybeAutoUpgrade,
};

},

// ===== config/constants.js =====
"config/constants.js": function (module, exports, __r) {
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

},

// ===== services/walletService.js =====
"services/walletService.js": function (module, exports, __r) {
// services/walletService.js - Wallet Operations with Firebase Transactions
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const firebaseService = __r("services/firebaseService.js");
const logger = __r("utils/logger.js");

/**
 * Get wallet balance for a user
 */
async function getBalance(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/balance`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

/**
 * OVER BALANCE — keeps `balance` from ever exceeding the user's CURRENT
 * plan's wallet limit. Anything over that limit lives in `overBalance`
 * instead — untouchable by withdrawals or purchases (debitWallet never
 * reads it) until the user's effective limit rises enough to absorb it
 * (upgrading a plan), at which point it merges back into `balance`.
 * Pass `walletLimitOverride` when the caller already knows the limit to
 * use (e.g. right after a plan change) to skip a redundant lookup.
 */
async function enforceWalletCap(userId, walletLimitOverride = null) {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const w = snap.val() || {};
  const balance = parseFloat(w.balance || 0);
  const overBalance = parseFloat(w.overBalance || 0);
  const total = Math.round((balance + overBalance) * 100) / 100;

  const limit = walletLimitOverride != null ? walletLimitOverride : await firebaseService.getEffectiveWalletLimit(userId);

  let newBalance, newOverBalance;
  if (limit <= 0 || total <= limit) {
    newBalance = total;
    newOverBalance = 0;
  } else {
    newBalance = limit;
    newOverBalance = Math.round((total - limit) * 100) / 100;
  }

  if (newBalance !== balance || newOverBalance !== overBalance) {
    await walletRef.update({ balance: newBalance, overBalance: newOverBalance, lastUpdated: Date.now() });
  }
  return { balance: newBalance, overBalance: newOverBalance };
}

async function getOverBalance(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/overBalance`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

/**
 * Credit wallet
 * NOTE: previously used Firebase's .transaction(), but the Admin SDK's
 * RTDB transactions are unreliable on serverless cold starts (Vercel) —
 * they can spuriously abort even when the data is valid, since the SDK
 * has no persistent local cache to optimistically work from. A simple
 * read-then-write is far more reliable here; true simultaneous double
 * requests for the same user are rare enough that this tradeoff is safe.
 * @param {string} userId
 * @param {number} amount - Amount to credit
 * @param {string} reason - Reason for credit (for logging)
 */
async function creditWallet(userId, amount, reason = '') {
  // Hide Wallet System: once enabled, Zap Cash can no longer receive new
  // money through ANY path — this function is the single choke point every
  // credit route funnels through (FamPay/Paytm webhooks, SMS webhook,
  // ZapUPI webhook, admin adjustments excepted — see adminAdjustWallet).
  // Existing balances are untouched; only new top-ups are blocked. This is
  // a last-resort backstop — the real prevention is upstream, in
  // paymentLinkController/developerController refusing to create orders at
  // all for a merchant with no cashier connected once this is on. If this
  // guard actually fires in practice, it means something got past that
  // upstream check and should be investigated, not silently relied upon.
  const settings = await firebaseService.getSettings();
  if (settings.hideWalletSystemEnabled) {
    logger.warn(`creditWallet blocked by Hide Wallet System: User=${userId}, Amount=₹${amount}, Reason=${reason}`);
    return getBalance(userId);
  }

  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const currentBalance = currentWallet ? parseFloat(currentWallet.balance || 0) : 0;
  const rawNewBalance = Math.round((currentBalance + amount) * 100) / 100;
  await walletRef.update({ balance: rawNewBalance, lastUpdated: Date.now() });

  // Cap against the current plan's wallet limit — any overflow moves to
  // Over Balance instead of just sitting in `balance` unbounded.
  const capped = await enforceWalletCap(userId);
  logger.info(`Wallet credited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Balance=₹${capped.balance}, OverBalance=₹${capped.overBalance}`);
  return capped.balance;
}

/**
 * Debit wallet
 * Same reliability fix as creditWallet above — .transaction() on this
 * SDK/environment combo could spuriously report a committed:false abort
 * even when the balance was genuinely sufficient, which surfaced to users
 * as an incorrect "Insufficient balance" error on valid purchases.
 * @param {string} userId
 * @param {number} amount - Amount to debit
 * @param {string} reason - Reason for debit
 */
async function debitWallet(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  if (!currentWallet) throw new Error('INSUFFICIENT_BALANCE');
  const currentBalance = parseFloat(currentWallet.balance || 0);
  if (currentBalance < amount) throw new Error('INSUFFICIENT_BALANCE');
  const newBalance = Math.round((currentBalance - amount) * 100) / 100;
  await walletRef.update({ balance: newBalance, lastUpdated: Date.now() });
  logger.info(`Wallet debited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Balance=₹${newBalance}`);
  return newBalance;
}

/**
 * Manual wallet adjustment by admin (credit or debit)
 * @param {string} userId
 * @param {number} amount - Positive = credit, Negative = debit
 * @param {string} reason
 */
async function adminAdjustWallet(userId, amount, reason = 'Admin adjustment') {
  // Bypasses the Hide Wallet System guard in creditWallet deliberately —
  // that guard exists to stop new THIRD-PARTY money flowing in through
  // payment webhooks, not to stop the admin correcting a balance or
  // issuing a refund. Duplicates creditWallet's core logic rather than
  // calling it, specifically to skip that check.
  if (amount > 0) {
    const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
    const snap = await walletRef.once('value');
    const currentWallet = snap.val();
    const currentBalance = currentWallet ? parseFloat(currentWallet.balance || 0) : 0;
    const rawNewBalance = Math.round((currentBalance + amount) * 100) / 100;
    await walletRef.update({ balance: rawNewBalance, lastUpdated: Date.now() });
    const capped = await enforceWalletCap(userId);
    logger.info(`Wallet credited (admin, bypasses Hide Wallet System): User=${userId}, Amount=₹${amount}, Reason=${reason}, Balance=₹${capped.balance}`);
    return capped.balance;
  } else if (amount < 0) {
    return await debitWallet(userId, Math.abs(amount), reason);
  }
  return await getBalance(userId);
}

/* ============================================================
   ZAP BONUS — a separate, currently-inert balance.
   Deliberately isolated from every function above: nothing in
   subscriptionService/withdrawalController/paymentController reads or
   writes this. It exists purely so a balance can be tracked and shown to
   the user; what it can actually be spent on is a future decision.
   Structurally mirrors the cash wallet functions above for consistency,
   just pointed at wallet/bonusBalance instead of wallet/balance.
============================================================ */

async function getBonusBalance(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/bonusBalance`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

async function creditBonusWallet(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const currentBonus = currentWallet ? parseFloat(currentWallet.bonusBalance || 0) : 0;
  const newBonus = Math.round((currentBonus + amount) * 100) / 100;
  await walletRef.update({ bonusBalance: newBonus, bonusLastUpdated: Date.now() });
  logger.info(`Zap Bonus credited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Bonus=₹${newBonus}`);
  return newBonus;
}

async function debitBonusWallet(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const currentBonus = currentWallet ? parseFloat(currentWallet.bonusBalance || 0) : 0;
  if (currentBonus < amount) throw new Error('INSUFFICIENT_BONUS_BALANCE');
  const newBonus = Math.round((currentBonus - amount) * 100) / 100;
  await walletRef.update({ bonusBalance: newBonus, bonusLastUpdated: Date.now() });
  logger.info(`Zap Bonus debited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Bonus=₹${newBonus}`);
  return newBonus;
}

async function adminAdjustBonusWallet(userId, amount, reason = 'Admin adjustment') {
  if (amount > 0) {
    return await creditBonusWallet(userId, amount, reason);
  } else if (amount < 0) {
    return await debitBonusWallet(userId, Math.abs(amount), reason);
  }
  return await getBonusBalance(userId);
}

/* ============================================================
   ZAP CREDIT — the balance that pays a merchant's per-transaction
   commission whenever a customer completes an order (Payment Link,
   Store purchase, Cashier checkout). Separate from Zap Cash: Zap Cash
   is the merchant's real money, Zap Credit is purely "fuel" spent to
   accept payments. New users start with a signup grant (see
   config/constants.js ZAP_CREDIT_SIGNUP_GRANT); existing users are
   backfilled once the same way (see firebaseService.upsertUser).
   Converting Zap Cash -> Zap Credit is 1:1 and free (0% commission —
   it's the merchant moving their own money internally). Recharging
   via UPI credits this balance directly once the top-up order succeeds.
============================================================ */

async function getZapCredit(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/zapCredit`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

async function creditZapCredit(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const current = currentWallet ? parseFloat(currentWallet.zapCredit || 0) : 0;
  const newBalance = Math.round((current + amount) * 100) / 100;
  await walletRef.update({ zapCredit: newBalance, zapCreditLastUpdated: Date.now() });
  logger.info(`Zap Credit credited: User=${userId}, Amount=${amount}, Reason=${reason}, Balance=${newBalance}`);
  return newBalance;
}

async function debitZapCredit(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const current = currentWallet ? parseFloat(currentWallet.zapCredit || 0) : 0;

  // Was: `if (current < amount) throw new Error('INSUFFICIENT_ZAP_CREDIT')`.
  // Every one of this function's ~9 call sites across
  // fampayService/paytmService/smsWebhookController/zapWebhook wraps the
  // call in try/catch and only logs the error — meaning whenever a
  // merchant's Zap Credit balance was even slightly below the commission
  // owed on ONE order, that entire commission silently went uncollected,
  // with nothing but a log line to show for it. A merchant could keep
  // accepting payments indefinitely once their balance dipped low enough
  // that no single order's commission fit anymore.
  //
  // Fix: debit whatever is actually available (down to exactly 0) rather
  // than refusing the whole amount. The platform is never worse off than
  // before (some commission collected beats none), and the negative
  // balance case doesn't apply here since debits are clamped to what
  // exists — a merchant simply owes nothing further once their credit
  // hits zero, which existing plan-purchase / order-creation gates
  // (checkSufficientCreditForOrder) are what should stop new orders from
  // being accepted in the first place, not this function silently eating
  // the shortfall after the fact.
  const debited = Math.min(current, amount);
  const newBalance = Math.round((current - debited) * 100) / 100;
  await walletRef.update({ zapCredit: newBalance, zapCreditLastUpdated: Date.now() });

  if (debited < amount) {
    logger.warn(`Zap Credit debit SHORTFALL: User=${userId}, Owed=${amount}, Collected=${debited}, Reason=${reason}, Balance=${newBalance}`);
  } else {
    logger.info(`Zap Credit debited: User=${userId}, Amount=${amount}, Reason=${reason}, Balance=${newBalance}`);
  }
  return newBalance;
}

/**
 * Checks whether a user has enough Zap Credit to cover the commission
 * on an order of the given amount, using their plan's commissionPercent.
 * Used to gate checkout creation BEFORE a payment link/page is issued,
 * so a customer never lands on a checkout page the merchant can't
 * actually get paid out for.
 * @returns {{ ok: boolean, required: number, available: number }}
 */
async function checkSufficientCreditForOrder(userId, orderAmount, commissionPercent) {
  const required = Math.round((orderAmount * commissionPercent) / 100 * 100) / 100;
  const available = await getZapCredit(userId);
  return { ok: available >= required, required, available };
}

/**
 * Admin manual adjustment (credit or debit), mirrors adminAdjustWallet.
 */
async function adminAdjustZapCredit(userId, amount, reason = 'Admin adjustment') {
  if (amount > 0) {
    return await creditZapCredit(userId, amount, reason);
  } else if (amount < 0) {
    return await debitZapCredit(userId, Math.abs(amount), reason);
  }
  return await getZapCredit(userId);
}

module.exports = {
  getBalance,
  creditWallet,
  debitWallet,
  adminAdjustWallet,
  enforceWalletCap,
  getOverBalance,
  getBonusBalance,
  creditBonusWallet,
  debitBonusWallet,
  adminAdjustBonusWallet,
  getZapCredit,
  creditZapCredit,
  debitZapCredit,
  checkSufficientCreditForOrder,
  adminAdjustZapCredit,
};

},

// ===== services/firebaseService.js =====
"services/firebaseService.js": function (module, exports, __r) {
// services/firebaseService.js - Firebase RTDB Operations
const { ref, serverTimestamp, admin } = __r("firebase/admin.js");
const { DB_PATHS, DEFAULT_SETTINGS, ZAP_CREDIT_SIGNUP_GRANT } = __r("config/constants.js");
const logger = __r("utils/logger.js");

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
  const { DEFAULT_PLANS } = __r("config/constants.js");
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

},

// ===== services/notificationService.js =====
"services/notificationService.js": function (module, exports, __r) {
// services/notificationService.js - Notification System
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS, NOTIFICATION_TYPE } = __r("config/constants.js");
const fcmService = __r("services/fcmService.js");
const logger = __r("utils/logger.js");

/**
 * Create a notification for a user.
 *
 * Also sends a push notification (FCM) to every device the user has
 * registered — this is the ONLY place that needs to know about push at
 * all, since every notification in this app (payment success/failed,
 * wallet credit, withdrawal status, subscription events, admin notices,
 * test-mode simulations, etc.) already flows through this one function.
 * fcmService.sendPushToUser never throws, so a push-delivery hiccup can
 * never break the in-app notification (or whatever triggered it, e.g. a
 * payment webhook) that this is called from.
 */
async function createNotification(userId, { title, message, type = NOTIFICATION_TYPE.GENERAL }) {
  const notifRef = ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).push();
  await notifRef.set({
    id: notifRef.key,
    title,
    message,
    type,
    isRead: false,
    createdAt: serverTimestamp(),
  });
  await fcmService.sendPushToUser(userId, { title, message, type });
  return notifRef.key;
}

/**
 * Get notifications for a user
 * NOTE: fetches the full set and sorts/slices in JS rather than using
 * orderByChild + limitToLast — that combination silently misbehaves on
 * Firebase RTDB if the .indexOn rule for 'createdAt' hasn't been applied
 * (a common deployment gap), causing newer notifications to be dropped
 * from the result while getUnreadCount (a simpler equalTo query) still
 * counts them correctly — exactly the "badge says 2, list shows 1" bug.
 */
async function getUserNotifications(userId, limit = 30) {
  const snap = await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).once('value');
  if (!snap.exists()) return [];
  const notifs = [];
  // Defensive: skip any null/malformed child so one bad record can't
  // affect the rest of the list.
  snap.forEach((child) => { const v = child.val(); if (v) notifs.push(v); });
  notifs.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
  return notifs.slice(0, limit);
}

/**
 * Mark notification as read
 */
async function markAsRead(userId, notifId) {
  await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}/${notifId}`).update({
    isRead: true,
  });
}

/**
 * Mark all notifications as read
 */
async function markAllAsRead(userId) {
  const snap = await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).once('value');
  if (!snap.exists()) return;
  const updates = {};
  snap.forEach((child) => {
    if (child.val().isRead === false) updates[`${child.key}/isRead`] = true;
  });
  if (Object.keys(updates).length) await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).update(updates);
}

/**
 * Get unread notification count
 */
async function getUnreadCount(userId) {
  const snap = await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).once('value');
  if (!snap.exists()) return 0;
  let count = 0;
  snap.forEach((child) => { const v = child.val(); if (v && v.isRead === false) count++; });
  return count;
}

/**
 * Send notification to all users (admin broadcast)
 */
async function broadcastNotification({ title, message, type = NOTIFICATION_TYPE.GENERAL }) {
  const usersSnap = await ref(DB_PATHS.USERS).once('value');
  if (!usersSnap.exists()) return 0;

  let count = 0;
  const promises = [];

  usersSnap.forEach((child) => {
    const uid = child.key;
    const user = child.val();
    if (!user.isBanned && user.role !== 'admin') {
      promises.push(createNotification(uid, { title, message, type }));
      count++;
    }
  });

  await Promise.all(promises);
  logger.info(`Broadcast sent to ${count} users: ${title}`);
  return count;
}

/**
 * Payment success notification
 */
async function notifyPaymentSuccess(userId, amount, orderId) {
  return createNotification(userId, {
    title: '💰 Payment Received',
    message: `₹${amount} has been added to your wallet. Order: ${orderId}`,
    type: NOTIFICATION_TYPE.PAYMENT,
  });
}

/**
 * Withdrawal status notification
 */
async function notifyWithdrawalStatus(userId, amount, status, adminNote = '') {
  const isApproved = status === 'approved';
  return createNotification(userId, {
    title: isApproved ? '✅ Withdrawal Approved' : '❌ Withdrawal Rejected',
    message: isApproved
      ? `Your withdrawal request of ₹${amount} has been approved and will be processed soon.`
      : `Your withdrawal request of ₹${amount} was rejected. ${adminNote ? 'Reason: ' + adminNote : ''}`,
    type: NOTIFICATION_TYPE.WITHDRAWAL,
  });
}

module.exports = {
  createNotification,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  broadcastNotification,
  notifyPaymentSuccess,
  notifyWithdrawalStatus,
};

},

// ===== services/fcmService.js =====
"services/fcmService.js": function (module, exports, __r) {
// services/fcmService.js - Firebase Cloud Messaging (push notifications)
//
// Called from exactly one place — notificationService.createNotification —
// so every existing notification trigger in the app (payment success/
// failed, wallet credit, withdrawal status, subscription events, admin
// notices, Test Mode simulations, etc.) automatically sends a push too,
// with zero changes needed anywhere else.
//
// Uses the SAME Firebase Admin app already initialized for the Realtime
// Database (firebase/admin.js) — admin.messaging() needs no separate
// credential or setup.
//
// Sending is always best-effort: every function here swallows its own
// errors and never throws, because a push-delivery hiccup must never
// break the payment webhook / withdrawal update / notification write it
// was triggered from.
const crypto = require('crypto');
const { ref, admin } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");

/**
 * Realtime Database keys can't contain '.', '#', '$', '[', ']', or '/'.
 * FCM tokens are usually safe but can contain ':' and vary by platform,
 * so hash to a stable, safe key instead of sanitizing the token itself —
 * this also naturally de-dupes if the same device registers twice.
 */
function tokenKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Register (or refresh) one device's FCM token for a user. Safe to call
 * repeatedly with the same token — it's just a keyed upsert, so a page
 * reload re-registering the same token is a no-op in practice.
 */
async function registerToken(uid, token, meta = {}) {
  if (!uid || !token) throw new Error('uid and token are required');
  await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens/${tokenKey(token)}`).set({
    token,
    platform: meta.platform || 'web',
    userAgent: (meta.userAgent || '').slice(0, 200),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });
}

/** Remove one device's token — e.g. when notifications are turned off. */
async function unregisterToken(uid, token) {
  if (!uid || !token) return;
  await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens/${tokenKey(token)}`).remove();
}

/**
 * Send a push notification to every device a user has registered.
 * Never throws — always resolves to a result object instead, so callers
 * (like the test-push endpoint) can show the caller exactly what
 * happened without anyone needing to dig through server logs:
 *   { ok, deviceCount, successCount, failureCount, errors: [{code,message}] }
 * The normal notificationService.createNotification flow just awaits this
 * and ignores the result — nothing about that path changes.
 */
async function sendPushToUser(uid, { title, message, type }) {
  try {
    const snap = await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens`).once('value');
    if (!snap.exists()) {
      logger.info(`FCM: no registered devices for user ${uid} — nothing to send`);
      return { ok: false, deviceCount: 0, successCount: 0, failureCount: 0, errors: [], reason: 'no_devices_registered' };
    }

    const entries = Object.entries(snap.val());
    const tokens = entries.map(([, v]) => v?.token).filter(Boolean);
    if (tokens.length === 0) {
      logger.info(`FCM: user ${uid} has token entries but no usable token values`);
      return { ok: false, deviceCount: 0, successCount: 0, failureCount: 0, errors: [], reason: 'no_usable_tokens' };
    }

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: message },
      data: { type: type || 'general' },
      webpush: {
        fcmOptions: { link: (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '') || '/' },
        notification: {
          icon: 'https://res.cloudinary.com/dihj6dmbb/image/upload/v1782028733/quickurl/20260621132708_1782028720083.png',
        },
      },
    });

    logger.info(`FCM: sent to ${tokens.length} device(s) for user ${uid} — ${resp.successCount} succeeded, ${resp.failureCount} failed`);

    // Prune tokens FCM says are no longer valid (uninstalled, expired,
    // browser data cleared, etc.) so this list stays clean over time —
    // and collect every failure's actual code/message so the caller can
    // see it directly, not just in server logs.
    const deadKeys = [];
    const errors = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || 'unknown';
        const message = r.error?.message || '(no message)';
        logger.error(`FCM: token ${i} failed — ${code}: ${message}`);
        errors.push({ code, message });
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          deadKeys.push(entries[i][0]);
        }
      }
    });
    if (deadKeys.length > 0) {
      const updates = {};
      deadKeys.forEach((key) => { updates[key] = null; });
      await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens`).update(updates);
      logger.info(`FCM: pruned ${deadKeys.length} dead token(s) for user ${uid}`);
    }

    return {
      ok: resp.successCount > 0,
      deviceCount: tokens.length,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      errors,
    };
  } catch (err) {
    // Log the full error, not just .message — FCM/Admin SDK errors carry
    // a .code (e.g. messaging/third-party-auth-error,
    // messaging/mismatched-credential) that .message alone often omits.
    logger.error(`FCM push send error for user ${uid}: [${err.code || 'no-code'}] ${err.message}`);
    return {
      ok: false,
      deviceCount: 0,
      successCount: 0,
      failureCount: 0,
      errors: [{ code: err.code || 'no-code', message: err.message }],
      reason: 'send_threw',
    };
  }
}

module.exports = { registerToken, unregisterToken, sendPushToUser };

},

// ===== services/promoService.js =====
"services/promoService.js": function (module, exports, __r) {
// services/promoService.js
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS, DEFAULT_PROMO_CODES } = __r("config/constants.js");
const walletService = __r("services/walletService.js");
const notificationService = __r("services/notificationService.js");
const logger = __r("utils/logger.js");

/**
 * Seed default promo codes once — never overwrites existing codes
 * (so admin edits made later are preserved).
 */
async function seedDefaultPromoCodes() {
  for (const promo of Object.values(DEFAULT_PROMO_CODES)) {
    const snap = await ref(`${DB_PATHS.PROMO_CODES}/${promo.code}`).once('value');
    if (!snap.exists()) {
      await ref(`${DB_PATHS.PROMO_CODES}/${promo.code}`).set(promo);
      logger.info(`Seeded promo code: ${promo.code}`);
    }
  }
}

/**
 * Apply/redeem a promo code for a user. Throws a user-facing Error on
 * any validation failure (invalid code, expired, already used, etc).
 */
async function applyPromoCode(uid, codeInput) {
  const code = (codeInput || '').trim().toUpperCase();
  if (!code) throw new Error('Please enter a promo code');

  const snap = await ref(`${DB_PATHS.PROMO_CODES}/${code}`).once('value');
  if (!snap.exists()) throw new Error('Invalid promo code');
  const promo = snap.val();

  if (!promo.isActive) throw new Error('This promo code is no longer active');
  if (promo.expiresAt && Date.now() > promo.expiresAt) throw new Error('This promo code has expired');
  if (promo.maxUses !== -1 && (promo.usedCount || 0) >= promo.maxUses) {
    throw new Error('This promo code has reached its usage limit');
  }

  // Per-user one-time usage check
  const redemptionRef = ref(`${DB_PATHS.PROMO_REDEMPTIONS}/${uid}/${code}`);
  const redeemedSnap = await redemptionRef.once('value');
  if (redeemedSnap.exists()) throw new Error('You have already used this promo code');

  const value = parseFloat(promo.value) || 0;
  const balanceType = ['cash', 'credit'].includes(promo.balanceType) ? promo.balanceType : 'bonus';
  const label = balanceType === 'cash' ? 'Zap Cash' : balanceType === 'credit' ? 'Zap Credit' : 'Zap Bonus';

  if (value > 0) {
    if (balanceType === 'cash') await walletService.creditWallet(uid, value, `Promo code: ${code}`);
    else if (balanceType === 'credit') await walletService.creditZapCredit(uid, value, `Promo code: ${code}`);
    else await walletService.creditBonusWallet(uid, value, `Promo code: ${code}`);
  }

  await redemptionRef.set({ code, value, redeemedAt: serverTimestamp() });

  await notificationService.createNotification(uid, {
    title: '🎁 Promo Code Applied',
    message: `₹${value} added to your ${label} using code ${code}.`,
    type: 'general',
  });

  // Best-effort usage counter (read-then-write, same reliability fix as wallet)
  try {
    const counterSnap = await ref(`${DB_PATHS.PROMO_CODES}/${code}/usedCount`).once('value');
    await ref(`${DB_PATHS.PROMO_CODES}/${code}/usedCount`).set((counterSnap.val() || 0) + 1);
  } catch (e) { /* non-critical */ }

  return { code, value, balanceType, label };
}

module.exports = { seedDefaultPromoCodes, applyPromoCode };

},

// ===== middleware/rateLimiter.js =====
"middleware/rateLimiter.js": function (module, exports, __r) {
// middleware/rateLimiter.js - API Rate Limiting
const rateLimit = require('express-rate-limit');
const response = __r("helpers/response.js");

/**
 * General API rate limiter - 100 requests per 15 minutes
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many requests. Please try again later.', 429);
  },
});

/**
 * Auth rate limiter - 10 requests per 15 minutes
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many login attempts. Please wait 15 minutes.', 429);
  },
});

/**
 * Payment creation limiter - 20 requests per 15 minutes
 */
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many payment requests. Please try again later.', 429);
  },
});

/**
 * Withdrawal limiter - 5 requests per hour
 */
const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many withdrawal requests. Please try again later.', 429);
  },
});

/**
 * Public order-cancel limiter - 10 requests per 10 minutes per IP.
 * checkout.html's Cancel button has no auth (it's a customer-facing page),
 * so this is the only thing standing between it and someone hammering the
 * endpoint. Keyed by IP since there's no user/session here.
 */
const cancelOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many cancel requests. Please try again later.', 429);
  },
});

/**
 * ZapAPI (Developer Portal) limiter - 60 requests per 15 minutes.
 * Keyed by the merchant's ZapAPI key when present (falls back to IP), so
 * one merchant's own site/app can't eat into another merchant's bucket,
 * and a busy site still can't hammer the backend unbounded.
 */
const apiKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.zap_api) || req.headers['x-zapapi-key'] || req.ip,
  handler: (req, res) => {
    return response.error(res, 'Too many API requests. Please try again later.', 429);
  },
});

/**
 * OTP send limiter - 5 requests per 10 minutes, keyed by email+IP so one
 * email address can't be spammed by a different attacker IP and vice versa.
 * Deliberately tighter than authLimiter: every hit here sends a real email
 * through the cPanel mailbox, which has its own daily sending cap.
 */
const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${(req.body && req.body.email || '').toLowerCase()}:${req.ip}`,
  handler: (req, res) => {
    return response.error(res, 'Too many OTP requests. Please wait a few minutes.', 429);
  },
});

/**
 * OTP verify limiter - 10 attempts per 10 minutes per email+IP, separate
 * from otpSendLimiter so a user retyping a mistyped code doesn't burn
 * their send quota, while still bounding brute-force guesses at a 6-digit code.
 */
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${(req.body && req.body.email || '').toLowerCase()}:${req.ip}`,
  handler: (req, res) => {
    return response.error(res, 'Too many attempts. Please request a new code.', 429);
  },
});

/**
 * Agentic Support chat limiter - 20 messages per 10 minutes per signed-in
 * user (falls back to IP if req.user isn't set yet, though in practice this
 * always runs after `authenticate`). Every message here is a real, billed-
 * or-quota-consuming call to the NVIDIA API, so this exists purely for
 * cost/abuse control, not security.
 */
const agentChatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.uid) || req.ip,
  handler: (req, res) => {
    return response.error(res, 'You are sending messages too quickly. Please wait a few minutes and try again.', 429);
  },
});

// Staff sign-in. Looser than authLimiter because a whole shop's staff can sit
// behind one office IP; the per-account lockout in staffService.login is the
// real brute-force guard.
const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => response.error(res, 'Too many sign-in attempts. Please wait a few minutes.', 429),
});

// Customers typing promo codes on a checkout page (public endpoint).
const promoLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => response.error(res, 'Too many promo code attempts. Please wait a few minutes and try again.', 429),
});

module.exports = {
  staffLoginLimiter,
  promoLimiter,
  generalLimiter,
  authLimiter,
  paymentLimiter,
  withdrawalLimiter,
  apiKeyLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  agentChatLimiter,
  cancelOrderLimiter,
};

},

// ===== helpers/response.js =====
"helpers/response.js": function (module, exports, __r) {
// helpers/response.js - Standard API Response Helper

/**
 * Send success response
 */
const success = (res, message, data = null, statusCode = 200) => {
  const response = { success: true, message };
  if (data !== null) response.data = data;
  return res.status(statusCode).json(response);
};

/**
 * Send error response
 */
const error = (res, message, statusCode = 400, errors = null) => {
  const response = { success: false, message };
  if (errors) response.errors = errors;
  return res.status(statusCode).json(response);
};

/**
 * Send unauthorized response
 */
const unauthorized = (res, message = 'Unauthorized access') => {
  return res.status(401).json({ success: false, message });
};

/**
 * Send forbidden response
 */
const forbidden = (res, message = 'Access forbidden') => {
  return res.status(403).json({ success: false, message });
};

/**
 * Send not found response
 */
const notFound = (res, message = 'Resource not found') => {
  return res.status(404).json({ success: false, message });
};

/**
 * Send server error response
 */
const serverError = (res, message = 'Internal server error') => {
  return res.status(500).json({ success: false, message });
};

module.exports = { success, error, unauthorized, forbidden, notFound, serverError };


},

// ===== routes/config.js =====
"routes/config.js": function (module, exports, __r) {
// routes/config.js
// Public endpoint — serves CLIENT-SAFE config (Firebase web config + site name)
// from Vercel environment variables, so the frontend never needs to
// hardcode these values. Firebase client config is designed to be public
// (it's restricted by Firebase Security Rules, not by secrecy) — this is
// different from server secrets like ZAP_KEY, which NEVER go through this
// route and NEVER reach the frontend.
const express = require('express');
const router = express.Router();
const response = __r("helpers/response.js");
const firebaseService = __r("services/firebaseService.js");

router.get('/', async (req, res) => {
  // Never let a CDN/proxy/browser cache this — maintenanceMode must always
  // reflect the LIVE settings value, not a stale snapshot from a few
  // minutes ago when the admin toggle gets flipped back off.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const required = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_APP_ID',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    return response.error(
      res,
      `Server misconfigured — missing env vars: ${missing.join(', ')}. Set these in Vercel → Project Settings → Environment Variables.`,
      500
    );
  }

  let socialLinks = {};
  let maintenanceMode = false;
  let supportEmail = '';
  let hideWalletSystemEnabled = false;
  let fampayInviteLink = 'https://get.fampay.in/SOVIOEMTW-100P';
  let minZapCreditPurchase = 25;
  let agenticSupportEnabled = true;
  try {
    const settings = await firebaseService.getSettings();
    socialLinks = settings.socialLinks || {};
    maintenanceMode = !!settings.maintenanceMode;
    supportEmail = settings.supportEmail || '';
    hideWalletSystemEnabled = !!settings.hideWalletSystemEnabled;
    fampayInviteLink = settings.fampayInviteLink || fampayInviteLink;
    minZapCreditPurchase = settings.minZapCreditPurchase || minZapCreditPurchase;
    // Unset/missing = enabled (matches DEFAULT_SETTINGS) — only an explicit
    // `false` from the admin should hide the feature.
    agenticSupportEnabled = settings.agenticSupportEnabled !== false;
  } catch (e) { /* settings unreachable — return empty social links rather than failing config entirely */ }

  return response.success(res, 'Config fetched', {
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      databaseURL: process.env.FIREBASE_DATABASE_URL || '',
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID,
    },
    // Public VAPID key for Web Push (Firebase Console → Project settings
    // → Cloud Messaging → Web configuration → Generate key pair). Optional
    // on purpose — everything else keeps working without it, push
    // notifications just won't be offered until it's set.
    vapidKey: process.env.FCM_VAPID_KEY || '',
    siteName: process.env.SITE_NAME || 'ZapPay',
    socialLinks,
    maintenanceMode,
    supportEmail,
    hideWalletSystemEnabled,
    fampayInviteLink,
    minZapCreditPurchase,
    agenticSupportEnabled,
  });
});

module.exports = router;

},

// ===== routes/auth.js =====
"routes/auth.js": function (module, exports, __r) {
const express = require('express');
const router = express.Router();
const { googleAuth, getMe, logout } = __r("controllers/authController.js");
const { authenticate } = __r("middleware/auth.js");
const { authLimiter } = __r("middleware/rateLimiter.js");

router.post('/google', authLimiter, googleAuth);
router.get('/me', authenticate, getMe);
router.post('/logout', authenticate, logout);

module.exports = router;

// POST /api/auth/create-admin
router.post('/create-admin', authLimiter, async (req, res) => {
  const { idToken, secret } = req.body;
  if (!idToken || !secret) return res.status(400).json({ success:false, message:'idToken and secret required' });
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ success:false, message:'Invalid secret key' });

  const { getAuth, ref } = __r("firebase/admin.js");
  const firebaseService  = __r("services/firebaseService.js");
  const jwt = require('jsonwebtoken');
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decoded;
    await firebaseService.upsertUser(uid, { email, displayName: name || email, photoURL: picture || '' });
    await ref(`users/${uid}/role`).set('admin');
    const user  = await firebaseService.getUser(uid);
    const token = jwt.sign({ uid, email, role:'admin' }, process.env.JWT_SECRET, { expiresIn:'30d' });
    return res.json({ success:true, message:'Admin created', data:{ token, user:{ ...user, role:'admin' } } });
  } catch(err) {
    return res.status(400).json({ success:false, message: err.message });
  }
});

},

// ===== controllers/authController.js =====
"controllers/authController.js": function (module, exports, __r) {
// controllers/authController.js
const jwt = require('jsonwebtoken');
const { getAuth } = __r("firebase/admin.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * POST /api/auth/google
 * Works for ALL Firebase auth methods:
 * - Google Sign-In
 * - Email/Password Sign-In
 * - Email/Password Register
 * Firebase issues same ID token format for all methods.
 */
const googleAuth = async (req, res) => {
  try {
    const { idToken, referralCode, deviceId, deviceLabel } = req.body;
    if (!idToken) return response.error(res, 'Firebase ID token is required');

    // Verify Firebase ID token (works for any Firebase auth provider)
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (err) {
      logger.warn(`Invalid Firebase token: ${err.message}`);
      return response.unauthorized(res, 'Invalid or expired token. Please sign in again.');
    }

    const { uid, email, name, picture, firebase } = decodedToken;

    // Check maintenance mode
    const settings = await firebaseService.getSettings();
    const existingUser = await firebaseService.getUser(uid);

    // Banned users are still allowed to log in — the frontend shows them a
    // dedicated suspended screen (with the reason + a support chat) instead
    // of the dashboard. Every other endpoint stays off-limits to them via
    // the blockIfBanned middleware. They also bypass maintenance mode so
    // they can always reach that screen.
    if (settings.maintenanceMode && existingUser?.role !== 'admin' && !existingUser?.isBanned) {
      return response.error(res, 'Platform is under maintenance. Please try again later.', 503);
    }

    // Multi-device login is now allowed — an account can be signed in on
    // any number of devices at once. (Previously this blocked a second
    // device unless the first was logged out; removed per product
    // decision. See adminResetLoginActivity in adminController.js for the
    // admin-side "force everyone out" tool that replaces the old
    // single-device lock as the way to fully reset a compromised account.)

    // Upsert user — works for both Google and Email/Password
    const user = await firebaseService.upsertUser(uid, {
      email,
      displayName: name || email?.split('@')[0] || 'User',
      photoURL: picture || '',
      authProvider: firebase?.sign_in_provider || 'unknown',
      referralCode,
    });

    // Multi-device login: no device slot is claimed anymore, so nothing
    // to set here — every device gets its own valid token independently.

    // Generate JWT — tokenVersion is embedded so admin's "Reset Login
    // Activity" can invalidate every outstanding token for this account at
    // once (bump the stored version; old tokens carry the old number and
    // stop verifying) without needing a device concept at all.
    const token = jwt.sign(
      { uid, email, role: user.role, tokenVersion: user.tokenVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    await firebaseService.logActivity(uid, 'LOGIN', {
      method: firebase?.sign_in_provider || 'unknown',
      ip: req.ip,
      deviceLabel: deviceLabel || '',
    });

    logger.info(`User logged in: ${email} [${firebase?.sign_in_provider}]`);

    return response.success(res, 'Login successful', {
      token,
      user: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: user.role,
        walletBalance: user.wallet?.balance || 0,
        isBanned: !!user.isBanned,
        banReason: user.banReason || '',
        isNewUser: !!user.isNewUser,
        authProvider: user.authProvider || '',
      },
    });
  } catch (err) {
    logger.error('Auth error:', err.message);
    return response.serverError(res, 'Authentication failed. Please try again.');
  }
};

/** GET /api/auth/me */
const getMe = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    if (!user) return response.notFound(res, 'User not found');

    // Staff session: never hand back the owner's private profile (email, UPI,
    // bank details, balances) — just what the panel needs to render.
    if (req.user.staff) {
      return response.success(res, 'User fetched', {
        uid: user.uid,
        email: req.user.staff.username,
        displayName: req.user.staff.name,
        photoURL: '',
        role: 'user',
        isStaff: true,
        staff: req.user.staff,
        merchantDisplayName: user.merchantDisplayName || '',
        showOnboarding: false,
        isBanned: !!user.isBanned,
        banReason: user.banReason || '',
        impersonating: false,
      });
    }

    return response.success(res, 'User fetched', {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      phone: user.phone || '',
      upiId: user.upiId || '',
      upiHolderName: user.upiHolderName || '',
      bankDetails: user.bankDetails || null,
      checkoutTheme: (['zenith', 'aurora-x', 'prism'].includes(user.checkoutTheme)) ? user.checkoutTheme : 'zenith',
      checkoutThemeColor: user.checkoutThemeColor || '',
      // Payment Link now has exactly one theme (Aurora) — not really a
      // per-merchant choice anymore, but still returned for the
      // Customize Page to render its (single-option) picker and color
      // swatch consistently. Blue is the platform default color.
      paymentLinkTheme: 'aurora',
      paymentLinkThemeColor: user.paymentLinkThemeColor || '#2563EB',
      // Defaults to true (not false) so every EXISTING user — who never
      // had this field before today — keeps seeing onboarding popups
      // exactly like before; only explicitly saving showOnboarding=false
      // from the toggle turns it off.
      showOnboarding: user.showOnboarding !== false,
      // Hide Intent UPI Button — defaults to ON for everyone.
      hideIntent: user.hideIntent !== false,
      authProvider: user.authProvider || '',
      role: user.role,
      walletBalance: user.wallet?.balance || 0,
      bonusBalance: user.wallet?.bonusBalance || 0,
      isBanned: !!user.isBanned,
      banReason: user.banReason || '',
      impersonating: !!req.user.impersonatedBy,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/** POST /api/auth/logout */
const logout = async (req, res) => {
  try {
    // A staff member signing out must not touch the OWNER's device/session state.
    if (req.user.staff) return response.success(res, 'Logged out successfully');
    await firebaseService.clearActiveDevice(req.user.uid);
    await firebaseService.logActivity(req.user.uid, 'LOGOUT', { ip: req.ip });
  } catch {}
  return response.success(res, 'Logged out successfully');
};

module.exports = { googleAuth, getMe, logout };

},

// ===== middleware/auth.js =====
"middleware/auth.js": function (module, exports, __r) {
// middleware/auth.js - JWT Authentication Middleware
const jwt = require('jsonwebtoken');
const { ref } = __r("firebase/admin.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const { checkStaffAccess } = __r("config/staffPermissions.js");

/**
 * Verify JWT token and attach user to request
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return response.unauthorized(res, 'No token provided');
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return response.unauthorized(res, 'Token expired. Please login again.');
      }
      return response.unauthorized(res, 'Invalid token');
    }

    // Check if user still exists and is active
    const userSnap = await ref(`users/${decoded.uid}`).once('value');
    if (!userSnap.exists()) {
      return response.unauthorized(res, 'User not found');
    }

    const user = userSnap.val();

    // A token's tokenVersion must match the one currently stored on the
    // user record. Admin's "Reset Login Activity" bumps the stored value,
    // which instantly invalidates every token issued before that point —
    // this is what actually forces every device to log in again, since
    // there's no device slot to clear anymore (multi-device is allowed).
    // Skipped for impersonation tokens, which carry no tokenVersion at all.
    // Staff tokens (issued by POST /api/staff/login) carry the STAFF record's own
    // tokenVersion instead — checked below against that record.
    const isStaffToken = !!decoded.staffId && !decoded.impersonatedBy;
    if (!decoded.impersonatedBy && !isStaffToken && (decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return response.unauthorized(res, 'Your session was reset. Please log in again.');
    }

    // NOTE: banned users are still authenticated here (so they can reach
    // /auth/me, /auth/logout and the /support chat endpoints and see why
    // they were suspended). Routes that must stay off-limits to a banned
    // user add `blockIfBanned` after `authenticate` — see below.
    // ── Staff session ──────────────────────────────────────────────────
    // A staff member acts on the OWNER's data (token uid = owner uid) but may
    // only call the routes their permissions allow — everything else is
    // denied by default (see config/staffPermissions.js).
    let staffCtx = null;
    if (isStaffToken) {
      const stSnap = await ref(`staff/${decoded.uid}/${decoded.staffId}`).once('value');
      if (!stSnap.exists()) return response.unauthorized(res, 'This staff account no longer exists.');
      const st = stSnap.val();
      if ((decoded.tokenVersion || 0) !== (st.tokenVersion || 0)) {
        return response.unauthorized(res, 'Your session was reset. Please sign in again.');
      }
      if (!st.isActive || st.suspendedByPlan) {
        return response.unauthorized(res, 'Your staff account is not active. Contact the account owner.');
      }
      staffCtx = { id: st.id, name: st.name, username: st.username, role: st.role || '', permissions: st.permissions || [] };
    }

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: staffCtx ? 'user' : (user.role || 'user'), // a staff session is never an admin session
      isBanned: !!user.isBanned,
      banReason: user.banReason || '',
      impersonatedBy: decoded.impersonatedBy || null, // set only on admin "Login as User" tokens
      staff: staffCtx,
    };

    if (staffCtx) {
      const apiPath = (req.baseUrl + req.path).replace(/^\/api/, '');
      const access = checkStaffAccess(req.method, apiPath, staffCtx.permissions);
      if (!access.allowed) {
        return res.status(403).json({
          success: false,
          staffDenied: true,
          message: access.needs
            ? 'You do not have permission to do this. Ask the account owner to enable it for you.'
            : 'This action is only available to the account owner.',
        });
      }
    }

    next();
  } catch (err) {
    logger.error('Auth middleware error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * Optional auth - attach user if token present, continue either way
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = { uid: decoded.uid, email: decoded.email, role: decoded.role };
    } catch {
      // Invalid token - continue as unauthenticated
    }

    next();
  } catch (err) {
    next();
  }
};

/**
 * Blocks a banned user from a route. Must run AFTER `authenticate` (needs
 * req.user). Kept separate from `authenticate` on purpose — /auth/me,
 * /auth/logout and /support/* stay reachable for a banned user, everything
 * else (wallet, payments, links, withdrawals, etc.) uses this.
 */
const blockIfBanned = (req, res, next) => {
  if (req.user && req.user.isBanned) {
    return res.status(403).json({
      success: false,
      message: 'Your account has been suspended.',
      banned: true,
      banReason: req.user.banReason || '',
    });
  }
  next();
};

/**
 * Blocks the highest-risk, money-moving actions while an admin is using a
 * "Login as User" session (Controller → Login as User). Investigation-only
 * by design — an impersonated session can look at everything but can't
 * request a withdrawal or change payout details, so this can never itself
 * become a way to move a user's money.
 */
const blockIfImpersonating = (req, res, next) => {
  if (req.user && req.user.impersonatedBy) {
    return res.status(403).json({
      success: false,
      message: 'This action is disabled during an admin-assisted session.',
      impersonationBlocked: true,
    });
  }
  next();
};

module.exports = { authenticate, optionalAuth, blockIfBanned, blockIfImpersonating };

},

// ===== config/staffPermissions.js =====
"config/staffPermissions.js": function (module, exports, __r) {
// config/staffPermissions.js
// Single source of truth for what a staff account can do.
//
// A staff login receives a token that acts on the OWNER's data (same uid),
// but middleware/auth.js runs every staff request through checkStaffAccess()
// below. It is DEFAULT-DENY: a route that is not listed here is owner-only.
// That means a new endpoint added later can never be reached by staff by
// accident — it has to be added to ROUTE_RULES on purpose.

const PERMISSIONS = {
  dashboard: {
    label: 'Dashboard & balance',
    desc: 'See the wallet balance, overview and notifications.',
    icon: 'bi-grid-fill',
  },
  transactions: {
    label: 'Transactions',
    desc: 'View payment history and check the status of an order.',
    icon: 'bi-clock-history',
  },
  payment_links: {
    label: 'Payment Links',
    desc: 'Create, edit, enable, disable and delete payment links.',
    icon: 'bi-link-45deg',
  },
  withdrawals_view: {
    label: 'Withdrawal history (view only)',
    desc: 'See past withdrawals. Staff can never request a withdrawal or change payout details.',
    icon: 'bi-arrow-up-right-circle',
  },
  promo: {
    label: 'Promo codes',
    desc: 'Create, edit and delete promo codes for customers.',
    icon: 'bi-ticket-perforated-fill',
  },
};

const PERMISSION_KEYS = Object.keys(PERMISSIONS);

// One-tap starting points in the "Add staff" form. The owner can still tick
// any combination — these only pre-fill the checkboxes.
const ROLE_PRESETS = [
  { id: 'support', label: 'Support Agent', permissions: ['dashboard', 'transactions'] },
  { id: 'accountant', label: 'Accountant', permissions: ['dashboard', 'transactions', 'withdrawals_view'] },
  { id: 'manager', label: 'Manager', permissions: ['dashboard', 'transactions', 'payment_links', 'withdrawals_view', 'promo'] },
  { id: 'marketing', label: 'Marketing', permissions: ['dashboard', 'promo', 'payment_links'] },
];

// [HTTP method or '*', RegExp tested against the path AFTER "/api", permission | null]
// null = any logged-in staff member (no specific permission needed).
const ROUTE_RULES = [
  ['GET', /^\/auth\/me$/, null],
  ['POST', /^\/auth\/logout$/, null],
  ['GET', /^\/subscription\/my$/, null],

  ['GET', /^\/wallet\/balance$/, 'dashboard'],
  ['GET', /^\/notification\/(count|list)$/, 'dashboard'],
  ['PUT', /^\/notification\/(read\/[^/]+|read-all)$/, 'dashboard'],

  ['GET', /^\/payment\/(history|status\/[^/]+)$/, 'transactions'],

  ['*', /^\/payment-link\/(create|list|[^/]+|[^/]+\/(disable|enable|edit))$/, 'payment_links'],

  ['GET', /^\/withdrawal\/history$/, 'withdrawals_view'],

  ['*', /^\/promo-manager\/(list|create|[A-Za-z0-9]+|[A-Za-z0-9]+\/redemptions)$/, 'promo'],
];

/**
 * @param {string} method       HTTP method
 * @param {string} apiPath      path after "/api", e.g. "/payment-link/list"
 * @param {string[]} granted    permissions on the staff record
 * @returns {{allowed: boolean, needs?: string|null}}
 */
function checkStaffAccess(method, apiPath, granted) {
  const path = String(apiPath || '').replace(/\/+$/, '') || '/';
  const m = String(method || '').toUpperCase();
  for (const [ruleMethod, re, perm] of ROUTE_RULES) {
    if (ruleMethod !== '*' && ruleMethod !== m) continue;
    if (!re.test(path)) continue;
    if (perm === null) return { allowed: true };
    return { allowed: Array.isArray(granted) && granted.includes(perm), needs: perm };
  }
  return { allowed: false, needs: null };
}

module.exports = { PERMISSIONS, PERMISSION_KEYS, ROLE_PRESETS, ROUTE_RULES, checkStaffAccess };

},

// ===== routes/user.js =====
"routes/user.js": function (module, exports, __r) {
// routes/user.js
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = __r("middleware/auth.js");
const firebaseService = __r("services/firebaseService.js");
const subscriptionService = __r("services/subscriptionService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
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

},

// ===== routes/wallet.js =====
"routes/wallet.js": function (module, exports, __r) {
// routes/wallet.js
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const walletService = __r("services/walletService.js");
const response = __r("helpers/response.js");

router.use(authenticate, blockIfBanned);

router.get('/balance', async (req, res) => {
  try {
    const [balance, bonusBalance, overBalance, zapCredit] = await Promise.all([
      walletService.getBalance(req.user.uid),
      walletService.getBonusBalance(req.user.uid),
      walletService.getOverBalance(req.user.uid),
      walletService.getZapCredit(req.user.uid),
    ]);
    return response.success(res, 'Balance fetched', { balance, bonusBalance, overBalance, zapCredit });
  } catch (err) {
    return response.serverError(res, err.message);
  }
});

/**
 * POST /api/wallet/convert-to-credit
 * Move money from Zap Cash into Zap Credit, 1:1, no commission — this is
 * the merchant moving their own money internally, not a customer order.
 * Body: { amount }
 */
router.post('/convert-to-credit', async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) {
      return response.error(res, 'Enter a valid amount greater than ₹0');
    }

    const firebaseService = __r("services/firebaseService.js");
    const settings = await firebaseService.getSettings();
    const minPurchase = settings.minZapCreditPurchase || 25;
    if (amount < minPurchase) {
      return response.error(res, `Minimum Zap Credit top-up is ₹${minPurchase}.`);
    }

    const balance = await walletService.getBalance(req.user.uid);
    if (balance < amount) {
      return response.error(res, `Insufficient Zap Cash. Available: ₹${balance.toFixed(2)}`);
    }

    await walletService.debitWallet(req.user.uid, amount, 'Converted to Zap Credit');
    const newCredit = await walletService.creditZapCredit(req.user.uid, amount, 'Converted from Zap Cash');
    const newBalance = await walletService.getBalance(req.user.uid);

    return response.success(res, 'Converted to Zap Credit', { zapCredit: newCredit, balance: newBalance });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return response.error(res, 'Insufficient Zap Cash balance.');
    }
    return response.serverError(res, err.message);
  }
});

module.exports = router;

},

// ===== routes/payment.js =====
"routes/payment.js": function (module, exports, __r) {
// routes/payment.js
const express = require('express');
const router = express.Router();
const { createOrder, getPaymentStatus, getPaymentHistory, createOrderValidation } = __r("controllers/paymentController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

router.use(authenticate, blockIfBanned);

router.post('/create-order', paymentLimiter, createOrderValidation, createOrder);
router.get('/status/:orderId', getPaymentStatus);
router.get('/history', getPaymentHistory);

module.exports = router;

},

// ===== controllers/paymentController.js =====
"controllers/paymentController.js": function (module, exports, __r) {
// controllers/paymentController.js - Payment Controller
const { body, validationResult } = require('express-validator');
const zapService = __r("services/zapService.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const { buildCheckoutUrl } = __r("utils/checkoutUrlBuilder.js");

/**
 * Validation rules for creating an order
 */
const createOrderValidation = [
  body('amount')
    .notEmpty().withMessage('Amount is required')
    .isFloat({ min: 1, max: 100000 }).withMessage('Amount must be between ₹1 and ₹1,00,000'),
  body('remark')
    .optional()
    .isLength({ max: 100 }).withMessage('Remark must be under 100 characters')
    .trim()
    .escape(),
  body('customerMobile')
    .optional()
    .isMobilePhone('en-IN').withMessage('Invalid mobile number'),
];

/**
 * POST /api/payment/create-order
 * Create a Zap UPI payment order
 */
const createOrder = async (req, res) => {
  try {
    // Validate inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return response.error(res, 'Validation failed', 400, errors.array());
    }

    const { amount, remark, customerMobile, type } = req.body;
    const userId = req.user.uid;

    // Check maintenance mode
    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) {
      return response.error(res, 'Payment system is under maintenance.', 503);
    }

    // Wallet top-ups specifically need ₹50 minimum (matches the frontend's
    // Add Money modal). createOrderValidation's ₹1 floor above still stands
    // for other order types (payment links, quick links) — this is on top
    // of that, only for type === 'wallet_topup', enforced server-side so a
    // direct API call can't bypass the frontend's own ₹50 floor.
    if (type === 'wallet_topup' && parseFloat(amount) < 50) {
      return response.error(res, 'Minimum wallet top-up amount is ₹50', 400);
    }

    // Zap Credit top-ups (the "Pay via UPI" option in the Add Zap Credit
    // modal) share the same admin-editable minimum as the "Convert from
    // Zap Cash" option (routes/wallet.js's convert-to-credit) — one
    // setting governs "smallest amount addable to Zap Credit" regardless
    // of which of the two funding methods the merchant picks.
    if (type === 'zap_credit_topup') {
      const minTopup = settings.minZapCreditPurchase || 25;
      if (parseFloat(amount) < minTopup) {
        return response.error(res, `Minimum Zap Credit top-up is ₹${minTopup}.`, 400);
      }
    }

    // Check if user is active
    const user = await firebaseService.getUser(userId);
    if (!user || user.isBanned) {
      return response.forbidden(res, 'Account is not active');
    }

    // Generate unique order ID
    const orderId = zapService.generateOrderId(userId);

    // Include userId in remark for webhook tracking
    const fullRemark = remark
      ? `${remark} | ${userId}`
      : `ZapPay | ${userId}`;

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) {
        isSystemCashier = true;
      }
    }

    // Create order record in DB FIRST (before calling Zap API)
    await firebaseService.createPayment(orderId, {
      userId,
      amount: parseFloat(amount),
      remark: fullRemark,
      customerMobile: customerMobile || user.phone || '',
      type: type === 'wallet_topup' ? 'wallet_topup' : (type === 'zap_credit_topup' ? 'zap_credit_topup' : 'quick_link'),
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    if (isSystemCashier) {
        // Return success to the internal dashboard page
        // Same comma-separated FRONTEND_URL caveat as elsewhere — take only the first origin.
        const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
        const dashboardRedir = `${frontendUrl}/index.html?payment=success&order=${orderId}`;
        // Checkout customization comes from sysAdminUser (the account
        // whose FamPay collects this payment), not the customer — same
        // reasoning as subscriptionController.js's plan-purchase flow.
        const checkoutUrl = buildCheckoutUrl(sysAdminUser, { orderId, amount, upiId: sysAdminUser.fampay.upiId, redirectUrl: dashboardRedir, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });

        logger.info(`System Cashier topup order created: ${orderId} by user ${userId} for ₹${amount}`);
        
        return response.success(res, 'Order created successfully', {
            orderId: orderId,
            paymentUrl: checkoutUrl,
            amount: parseFloat(amount),
        });
    }

    // Call Zap UPI API (backend only - ZAP_KEY never exposed to frontend)
    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(parseFloat(amount).toFixed(2)),
      customerMobile: customerMobile || user.phone || '',
      remark: fullRemark,
    });

    logger.info(`Order created: ${orderId} by user ${userId} for ₹${amount}`);

    // Return payment URL to frontend (NOT the zap_key)
    return response.success(res, 'Order created successfully', {
      orderId: zapOrder.orderId,
      paymentUrl: zapOrder.paymentUrl,
      amount: parseFloat(amount),
    });

  } catch (err) {
    logger.error('Create order error:', err.message);
    return response.error(res, err.message || 'Failed to create payment order');
  }
};

/**
 * GET /api/payment/status/:orderId
 * Get payment status (from DB + optional API check)
 */
const getPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) return response.error(res, 'Order ID required');

    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Payment not found');

    // Only show payment to its owner (or admin)
    if (payment.userId !== req.user.uid && req.user.role !== 'admin') {
      return response.forbidden(res);
    }

    return response.success(res, 'Payment status fetched', {
      orderId: payment.orderId,
      amount: payment.amount,
      status: payment.status,
      type: payment.type,
      planId: payment.planId,
      txnId: payment.txnId || '',
      utr: payment.utr || '',
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    });
  } catch (err) {
    logger.error('Get payment status error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/payment/history
 * Get payment history for current user
 */
const getPaymentHistory = async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const payments = await firebaseService.getUserPayments(userId, limit);

    return response.success(res, 'Payment history fetched', { payments, total: payments.length });
  } catch (err) {
    logger.error('Get payment history error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  createOrder,
  getPaymentStatus,
  getPaymentHistory,
  createOrderValidation,
};

},

// ===== services/zapService.js =====
"services/zapService.js": function (module, exports, __r) {
// services/zapService.js - Zap UPI Gateway API Service
// CRITICAL: This file must NEVER be exposed to frontend
const axios = require('axios');
const logger = __r("utils/logger.js");

const ZAP_API_URL = process.env.ZAP_API_URL || 'https://pay.zapupi.com/api';
const ZAP_KEY = process.env.ZAP_KEY;

// FRONTEND_URL may now hold a comma-separated list (server.js's CORS
// allowlist splits on ',' to support multiple live domains during a
// domain migration, e.g. "https://YOUR-OTHER-DOMAIN.com,https://YOUR-DOMAIN.com").
// The default redirect URLs below need a SINGLE origin, not the raw
// comma-joined value — take the first one, which should be the current
// primary/production domain.
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');

/**
 * Sanitize remark for Zap UPI gateway.
 * UPI/payment gateways reject remarks containing emoji or non-ASCII
 * characters (e.g. plan names like "🥉 Bronze" cause "Invalid Remark").
 * Strips everything except letters, numbers, spaces and basic punctuation,
 * collapses whitespace, and falls back to a safe default if empty.
 */
function sanitizeRemark(text) {
  if (!text) return 'ZapPay Payment';
  const cleaned = String(text)
    .replace(/[^\x20-\x7E]/g, '')      // strip emoji & all non-ASCII chars
    .replace(/[^a-zA-Z0-9 .,\-_|:]/g, '') // keep only safe punctuation — NOT parentheses: the
                                           // gateway rejects any remark containing them with
                                           // "Invalid Remark", confirmed by comparing against
                                           // remarks that succeed (e.g. "Wallet Recharge - User
                                           // ID: 2", "Testing") vs ones that failed, which all
                                           // had a "(...)" segment
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'ZapPay Payment').slice(0, 50);
}

/**
 * Create a payment order with Zap UPI
 * @param {Object} params
 * @param {string} params.orderId - Unique order ID
 * @param {string} params.amount - Amount in INR
 * @param {string} [params.customerMobile] - Optional customer mobile
 * @param {string} [params.remark] - Optional remark
 */
async function createOrder({ orderId, amount, customerMobile, remark, successUrl, failedUrl, timeoutUrl, omitRedirectUrls }) {
  if (!ZAP_KEY) {
    throw new Error('ZAP_KEY not configured');
  }

  const payload = {
    zap_key: ZAP_KEY,
    order_id: orderId,
    amount: String(amount),
    remark: sanitizeRemark(remark),
  };

  // When the order will be opened via ZapUPI's single-html-web-kit.js
  // (embedded overlay + onSuccess/onFailed/onTimeout JS callbacks), the
  // SDK manages redirect detection internally — adding our own
  // success_url/failed_url/timeout_url here would conflict with that.
  if (!omitRedirectUrls) {
    payload.success_url = successUrl || `${PRIMARY_FRONTEND_URL}/index.html?payment=success&order=${orderId}`;
    payload.failed_url  = failedUrl  || `${PRIMARY_FRONTEND_URL}/index.html?payment=failed&order=${orderId}`;
    payload.timeout_url = timeoutUrl || `${PRIMARY_FRONTEND_URL}/index.html?payment=failed&order=${orderId}`;
  }

  // Add optional fields
  if (customerMobile) payload.customer_mobile = customerMobile;

  // Add webhook URL if configured
  if (process.env.WEBHOOK_URL) {
    payload.webhook_url = process.env.WEBHOOK_URL;
  }

  logger.info(`Creating Zap order: ${orderId}, Amount: ₹${amount}, Remark: ${payload.remark}`);

  const response = await axios.post(`${ZAP_API_URL}/create-order`, payload, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
  });

  const data = response.data;

  if (data.status !== 'success' && !data.payment_url) {
    throw new Error(data.message || 'Failed to create payment order');
  }

  return {
    paymentUrl: data.payment_url,
    orderId: data.order_id || orderId,
    status: data.status,
  };
}

/**
 * Check order payment status
 * @param {string} orderId - Order ID to check
 * Per official ZapUPI docs, the response is FLAT and 'status' here is the
 * actual payment status: "Pending" | "Success" | "Failed" — NOT a lowercase
 * API-call-wrapper status like create-order's 'status' field. Treating it
 * like the create-order response was a bug — it made this function throw
 * on every call except a real (rare) literal 'success' string, silently
 * breaking the webhook's server-side double-verification.
 */
async function getOrderStatus(orderId) {
  if (!ZAP_KEY) {
    throw new Error('ZAP_KEY not configured');
  }

  const response = await axios.post(
    `${ZAP_API_URL}/order-status`,
    { zap_key: ZAP_KEY, order_id: orderId },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );

  // { status: 'Pending'|'Success'|'Failed', amount, pay_amount, txn_id, utr, environment }
  return response.data;
}

/**
 * Generate a unique order ID
 */
function generateOrderId(userId) {
  const timestamp = Date.now();
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ZP${timestamp}${suffix}`;
}

module.exports = {
  createOrder,
  getOrderStatus,
  generateOrderId,
};

},

// ===== utils/checkoutUrlBuilder.js =====
"utils/checkoutUrlBuilder.js": function (module, exports, __r) {
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

},

// ===== routes/paymentLink.js =====
"routes/paymentLink.js": function (module, exports, __r) {
// routes/paymentLink.js
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/paymentLinkController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

// Public
router.get('/:linkId/public', ctrl.getLinkPublic);
router.get('/order/:orderId/status', ctrl.getLinkOrderStatus);
router.post('/:linkId/initiate', paymentLimiter, ctrl.initiatePayment);

// Authenticated (merchant)
router.post('/create', authenticate, blockIfBanned, paymentLimiter, ctrl.createLinkValidation, ctrl.createPaymentLink);
router.get('/list', authenticate, blockIfBanned, ctrl.getUserLinks);
router.put('/:linkId/disable', authenticate, blockIfBanned, ctrl.disableLink);
router.put('/:linkId/enable', authenticate, blockIfBanned, ctrl.enableLink);
router.put('/:linkId/edit', authenticate, blockIfBanned, ctrl.editLinkValidation, ctrl.editPaymentLink);
router.delete('/:linkId', authenticate, blockIfBanned, ctrl.deletePaymentLink);

module.exports = router;

},

// ===== controllers/paymentLinkController.js =====
"controllers/paymentLinkController.js": function (module, exports, __r) {
// controllers/paymentLinkController.js
const { body, validationResult } = require('express-validator');
const { ref } = __r("firebase/admin.js");
const zapService = __r("services/zapService.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const notificationService = __r("services/notificationService.js");
const subscriptionService = __r("services/subscriptionService.js");
const gatewayModeService = __r("services/gatewayModeService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const { buildCheckoutUrl } = __r("utils/checkoutUrlBuilder.js");
const { DB_PATHS } = __r("config/constants.js");
const crypto = require('crypto');

function generateLinkId() {
  return crypto.randomBytes(4).toString('hex');
}

const createPaymentLink = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    // NOTE: routingEngine is intentionally NOT accepted here. Routing is an
    // account-wide setting (user.apiRoutingEngine, controlled only from the
    // Developer Portal / ZapAPI section) — it must never be chosen per-link,
    // and every link always follows whatever the account is set to at the
    // moment it's actually paid (see initiatePayment below).
    const { amount, title, description, redirectUrl, usageLimit } = req.body;
    const userId = req.user.uid;

    const sub = await subscriptionService.getUserSubscription(userId);
    const plan = sub.plan;
    if (!plan) return response.error(res, 'Could not load your plan. Try again.');

    // Hide Wallet System: once enabled, a merchant must have their OWN
    // cashier (FamPay or Paytm) connected and selected before they can
    // create any new payment link at all — this is the actual prevention
    // point; creditWallet's own guard (walletService.js) is only a
    // backstop in case something slips past this. A merchant with no
    // cashier connected has nowhere legitimate for the link to route
    // money to once wallet top-ups are blocked, so refusing at creation
    // time (rather than letting them discover it later at checkout) is
    // the whole point of the popup this error is meant to trigger.
    const settings = await firebaseService.getSettings();
    if (settings.hideWalletSystemEnabled) {
      const merchantUser = await firebaseService.getUser(userId);
      const hasCashier =
        (merchantUser?.apiRoutingEngine === 'cashier' && merchantUser?.fampay?.isConnected) ||
        (merchantUser?.apiRoutingEngine === 'paytm_cashier' && merchantUser?.paytm?.isConnected) ||
        (merchantUser?.apiRoutingEngine === 'amazon_cashier' && merchantUser?.amazon?.isConnected);
      if (!hasCashier) {
        return response.error(res, 'Connect your own FamPay or Paytm cashier before creating payment links. Go to Zap API → Payment Routing to connect one.', 403, { requiresCashierConnect: true });
      }
    }

    await subscriptionService.checkAndResetMonthlyLinks(userId);
    const linksUsed = sub.paymentLinksUsedThisMonth || 0;
    if (plan.paymentLinksPerMonth !== -1 && linksUsed >= plan.paymentLinksPerMonth) {
      return response.error(res, `You've used all ${plan.paymentLinksPerMonth} payment links this month. Upgrade your plan for more.`);
    }

    const balance = await walletService.getBalance(userId);
    if (balance >= plan.walletLimit) {
      return response.error(res, `Your wallet has reached its limit of ₹${plan.walletLimit}. Withdraw funds to create new links.`);
    }

    let linkId = generateLinkId();
    let exists = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    while (exists.exists()) {
      linkId = generateLinkId();
      exists = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    }

    let expiresAt;
    if (req.body.expiryDays !== undefined && req.body.expiryDays !== null && req.body.expiryDays !== '') {
      const days = parseInt(req.body.expiryDays, 10);
      expiresAt = (days > 0) ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
    } else {
      expiresAt = plan.linkExpiryDays > 0 ? Date.now() + plan.linkExpiryDays * 24 * 60 * 60 * 1000 : null;
    }

    const user = await firebaseService.getUser(userId);

    const linkData = {
      id: linkId,
      userId,
      merchantName: user?.displayName || 'Merchant',
      title: title.trim(),
      description: description?.trim() || '',
      redirectUrl: redirectUrl?.trim() || '',
      amount: parseFloat(amount),
      status: 'active',
      expiresAt,
      planId: plan.id,
      planName: plan.name,
      commissionPercent: plan.commissionPercent,
      usageLimit: usageLimit ? parseInt(usageLimit, 10) : null, // NEW: Save Usage Limit
      createdAt: Date.now(),
      paidAt: null,
      paymentCount: 0,
      totalCollected: 0,
    };

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).set(linkData);
    await subscriptionService.incrementLinkCount(userId);

    await firebaseService.logActivity(userId, 'PAYMENT_LINK_CREATED', {
      linkId, title: linkData.title, amount: linkData.amount, expiresAt,
    });

    // FRONTEND_URL may hold a comma-separated list of live domains (see
    // server.js's CORS allowlist / zapService.js's PRIMARY_FRONTEND_URL for
    // the same pattern) — always take just the first entry for a public URL.
    const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
    const publicUrl = `${frontendUrl}/pay.html?id=${linkId}`;
    logger.info(`Payment link created: ${linkId} by ${userId}`);

    return response.success(res, 'Payment link created!', {
      linkId, publicUrl, amount: linkData.amount, title: linkData.title, redirectUrl: linkData.redirectUrl,
      expiresAt, usageLimit: linkData.usageLimit,
      linksRemaining: plan.paymentLinksPerMonth === -1 ? 'Unlimited' : plan.paymentLinksPerMonth - linksUsed - 1,
    });
  } catch (err) {
    logger.error('Create payment link error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getUserLinks = async (req, res) => {
  try {
    const snap = await ref(DB_PATHS.PAYMENT_LINKS).orderByChild('userId').equalTo(req.user.uid).once('value');
    const links = [];
    if (snap.exists()) {
      snap.forEach((child) => {
        const link = child.val();
        if (link.expiresAt && Date.now() > link.expiresAt && link.status === 'active') {
          link.status = 'expired';
        }
        // Limit Check Logic
        if (link.usageLimit && link.paymentCount >= link.usageLimit && link.status === 'active') {
          link.status = 'expired'; // Treat as expired visually
        }
        links.push(link);
      });
    }
    links.sort((a, b) => b.createdAt - a.createdAt);
    return response.success(res, 'Links fetched', { links, total: links.length });
  } catch (err) {
    logger.error('Get user links error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getLinkPublic = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Payment link not found');

    const link = snap.val();

    if (link.status === 'disabled') return response.error(res, 'This payment link has been disabled by the merchant.');
    if (link.expiresAt && Date.now() > link.expiresAt) return response.error(res, 'This payment link has expired.');
    
    // NEW: Usage Limit Check
    if (link.usageLimit && link.paymentCount >= link.usageLimit) {
      return response.error(res, 'This payment link has reached its maximum usage limit.');
    }

    const merchant = await firebaseService.getUser(link.userId);
    if (!merchant || merchant.isBanned) return response.error(res, 'This payment link is no longer available.');

    return response.success(res, 'Link details fetched', {
      linkId: link.id, merchantName: link.merchantName, title: link.title, description: link.description,
      amount: link.amount, expiresAt: link.expiresAt, status: link.status, redirectUrl: link.redirectUrl || '',
      // Payment Link now offers exactly ONE theme — Aurora — forced for
      // every merchant (this is not a per-merchant choice anymore; see
      // routes/user.js's paymentLinkTheme validator, which now only
      // accepts 'aurora'). Blue (#2563EB) is the platform default color;
      // a merchant can still repaint it via paymentLinkThemeColor on the
      // Customize Page. pay.html/link/index.html render Aurora as CSS
      // (aurora is a --brand-* palette on those files, not a dedicated
      // FILE like Zenith/Aurora X/Prism are for Checkout Page).
      checkoutTheme: 'aurora', checkoutThemeColor: merchant.paymentLinkThemeColor || '#2563EB',
      fampayConnected: !!merchant.fampay?.isConnected, fampayUpiId: merchant.fampay?.isConnected ? merchant.fampay.upiId : null,
      routingEngine: link.routingEngine || 'wallet',
    });
  } catch (err) {
    logger.error('Get link public error:', err.message);
    return response.serverError(res, err.message);
  }
};

const initiatePayment = async (req, res) => {
  try {
    const { linkId } = req.params;
    const { customerMobile, customerName, useEmbedded } = req.body;

    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Payment link not found');

    const link = snap.val();

    if (link.status === 'disabled') return response.error(res, 'This payment link is disabled.');
    if (link.expiresAt && Date.now() > link.expiresAt) return response.error(res, 'This payment link has expired.');
    
    // NEW: Usage Limit Check
    if (link.usageLimit && link.paymentCount >= link.usageLimit) {
      return response.error(res, 'This payment link has reached its maximum usage limit.');
    }

    const orderId = zapService.generateOrderId(link.userId);
    const gatewayMode = await gatewayModeService.getMode(link.userId);

    if (gatewayMode === 'test') {
      await firebaseService.createPayment(orderId, {
        userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId, isTest: true,
      });
      await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });

      // The customer lands on the SAME checkout page the merchant picked
      // on the Customize Page's Checkout Page Theme (Zenith / Aurora X /
      // Prism) — not the separate legacy test.html — with &test_mode=1 so
      // that page shows its own floating test button (bottom-right) for
      // simulating Success / Failed / Cancelled. Same fix as
      // developerController.js's ZapAPI test-mode branch; this is the
      // Payment Link side of the same change. UPI id is a clearly-fake
      // placeholder: the QR and app buttons still render so the page
      // looks real, but there's no real account behind it for money to
      // ever reach.
      const merchantForTest = await firebaseService.getUser(link.userId);
      const testModeSettings = await firebaseService.getSettings();
      const testCheckoutUrl = buildCheckoutUrl(merchantForTest, {
        orderId, amount: link.amount, upiId: 'test@zappay', testMode: true,
        timeoutSec: testModeSettings.amountTimeVerificationMode ? 180 : 480,
      });
      return response.success(res, 'Payment initiated (Test Mode)', { paymentUrl: testCheckoutUrl, orderId, amount: link.amount, isTest: true });
    }

    const merchantSub = await subscriptionService.getUserSubscription(link.userId);
    const balance = await walletService.getBalance(link.userId);
    if (balance + link.amount > merchantSub.plan.walletLimit) {
      return response.error(res, 'Merchant wallet is full. Please contact the merchant.');
    }

    // ─── Zap Credit gate ─────────────────────────────────────────
    // Every completed order costs the merchant commissionPercent% of the
    // order amount in Zap Credit. If they don't have enough to cover it,
    // don't let the customer land on a checkout page at all — fail here,
    // before any order record or payment URL is created.
    const commissionPercent = merchantSub.plan.commissionPercent ?? 5;
    const creditCheck = await walletService.checkSufficientCreditForOrder(link.userId, link.amount, commissionPercent);
    if (!creditCheck.ok) {
      logger.warn(`Insufficient Zap Credit for link ${linkId}: user=${link.userId} required=${creditCheck.required} available=${creditCheck.available}`);
      return response.error(res, 'Insufficient Zap Credit. This merchant needs to recharge Zap Credit before they can accept this payment.');
    }

    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) return response.error(res, 'Payment system under maintenance.', 503);

    const merchantUser = await firebaseService.getUser(link.userId);
    const isFamPay = merchantUser?.fampay?.isConnected;
    const isPaytm = merchantUser?.paytm?.isConnected;
    const isAmazon = merchantUser?.amazon?.isConnected;

    // Hide Wallet System backstop: covers a link created before the toggle
    // was turned on, or before the merchant's cashier got disconnected
    // afterward. createPaymentLink already refuses to make NEW links
    // without a connected cashier once this is on, but an existing link
    // could still be sitting out there — this is what actually stops a
    // customer from reaching checkout on one of those.
    const hasCashierNow =
      (merchantUser?.apiRoutingEngine === 'cashier' && isFamPay) ||
      (merchantUser?.apiRoutingEngine === 'paytm_cashier' && isPaytm) ||
      (merchantUser?.apiRoutingEngine === 'amazon_cashier' && isAmazon);
    if (settings.hideWalletSystemEnabled && !hasCashierNow) {
      return response.error(res, 'This merchant has not connected their own cashier to receive money. Payments cannot be accepted on this link right now.', 403);
    }

    // Routing is decided live, from the merchant's account-wide setting
    // (Developer Portal → Payment Routing), never from anything stored on
    // the link itself — a link created weeks ago must immediately reflect
    // a routing change made today. 'cashier' is only honored if FamPay is
    // ACTUALLY connected right now; if the merchant switched the setting
    // to cashier earlier but has since disconnected FamPay (or never
    // connected it), this safely falls through to the normal wallet flow
    // below instead of building a checkout with no UPI ID to pay to.
    const useCashier = merchantUser?.apiRoutingEngine === 'cashier' && isFamPay;
    const useAmazon = merchantUser?.apiRoutingEngine === 'amazon_cashier' && isAmazon;

    if (useAmazon) {
      await firebaseService.createPayment(orderId, {
        userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId,
        paymentMethod: 'amazon', cashierUpiId: merchantUser.amazon.upiId, routingEngine: 'amazon_cashier', commissionPercent
      });
      await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });
      const safeRedirectAmazon = link.redirectUrl || `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`;
      const amazonCheckoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: link.amount, upiId: merchantUser.amazon.upiId, redirectUrl: safeRedirectAmazon, method: 'amazon', timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
      return response.success(res, 'Payment initiated via Amazon Pay Cashier', { paymentUrl: amazonCheckoutUrl, orderId, amount: link.amount, isTest: false, method: 'amazon_cashier' });
    }

    if (useCashier) {
      await firebaseService.createPayment(orderId, {
        userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId,
        paymentMethod: 'fampay', cashierUpiId: merchantUser.fampay.upiId, routingEngine: 'cashier', commissionPercent
      });
      await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });
      // Was: redirect_url only got appended when link.redirectUrl was set,
      // with no fallback — unlike the system_cashier branch below, which
      // always builds a safeRedirect. Since checkout.html is a full-page
      // navigation (not an iframe — window.location.href, not
      // ZapUPI.loadPayment), its own inIframe check is always false, so it
      // never posts back to a parent. Its ONLY way home is the redirect_url
      // param; missing that, it fell to document.referrer (unreliable across
      // WebViews/app browsers) or '/' — landing on the site root instead of
      // link.html, which is why the customer never saw their payment record.
      // Mirrors system_cashier's own default exactly, so both routes behave
      // the same when the merchant hasn't set a custom redirectUrl.
      const safeRedirect = link.redirectUrl || `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`;
      const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: link.amount, upiId: merchantUser.fampay.upiId, redirectUrl: safeRedirect, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
      return response.success(res, 'Payment initiated via Cashier', { paymentUrl: checkoutUrl, orderId, amount: link.amount, isTest: false, method: 'cashier' });
    }

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (!isFamPay && settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, {
      userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId,
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi', 
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null, 
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet', 
      commissionPercent,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });

    if (isSystemCashier) {
      // Was: always built the internal pay.html fallback here, completely
      // ignoring link.redirectUrl even when the merchant had explicitly
      // configured one on this Payment Link — unlike the useCashier branch
      // above it, which already correctly prefers link.redirectUrl. Since
      // most merchants don't have their own FamPay connected, THIS branch
      // (pooled/system cashier) is the common path for Payment Links, so
      // this one bug meant most merchants' configured redirect URLs were
      // silently never honored — the customer always ended up on ZapPay's
      // own generic result page instead of the merchant's own site/app.
      // Now mirrors useCashier's logic exactly.
      const safeRedirect = link.redirectUrl || `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`;
      const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount: link.amount, upiId: sysAdminUser.fampay.upiId, redirectUrl: safeRedirect, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
      return response.success(res, 'Payment initiated via System Cashier', { paymentUrl: checkoutUrl, orderId, amount: link.amount, isTest: false, method: 'system_cashier' });
    } else {
      // NOTE: previously there was an `else if (isFamPay)` branch here that
      // forced ANY merchant with FamPay connected through the cashier
      // checkout flow — even when their apiRoutingEngine was explicitly set
      // to 'wallet'. That silently broke "switch back to wallet routing"
      // (payments kept going through FamPay/checkout.html, and correctly-
      // routed wallet payments never got their commission-adjusted amount
      // credited via the normal handleLinkPayment path) and has been
      // removed. FamPay-connected merchants who are actually routed to
      // 'cashier' were already returned via the useCashier branch above —
      // reaching this point means the account is genuinely on wallet/ZapUPI
      // routing, so it must always go through the real ZapUPI order flow.
      const zapOrder = await zapService.createOrder({
        orderId, amount: String(link.amount.toFixed(2)), customerMobile: customerMobile || '', remark: link.title, omitRedirectUrls: !!useEmbedded,
        ...(useEmbedded ? {} : {
          successUrl: `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`,
          failedUrl:  `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=failed`,
          timeoutUrl: `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=timeout`,
        }),
      });
      return response.success(res, 'Payment initiated', { paymentUrl: zapOrder.paymentUrl, orderId, amount: link.amount, isTest: false, method: 'zapupi' });
    }
  } catch (err) {
    logger.error('Initiate link payment error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getLinkOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    // Serves any cashier-routed order checkout.html might poll: payment
    // links (linkId), store products (storeId), and direct ZapAPI orders
    // (type: 'api', no linkId/storeId of their own) — checkout.html polls
    // this same endpoint regardless of which of these created the order.
    if (!payment) return response.notFound(res, 'Order not found');

    if (payment.status === 'pending' && (payment.paymentMethod === 'fampay' || payment.routingEngine === 'cashier' || payment.routingEngine === 'system_cashier' || payment.paymentMethod === 'amazon')) {
      const verifier = payment.paymentMethod === 'amazon'
        ? __r("services/amazonService.js")
        : __r("services/fampayService.js");
      await verifier.verifyPayment(orderId);
      const updatedPayment = await firebaseService.getPayment(orderId);
      if (updatedPayment) payment.status = updatedPayment.status;
    }

    return response.success(res, 'Status fetched', { orderId, status: payment.status, linkId: payment.linkId || null });
  } catch (err) {
    logger.error('Get link order status error:', err.message);
    return response.serverError(res, err.message);
  }
};

const editPaymentLink = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');

    const link = snap.val();
    if (link.userId !== req.user.uid) return response.forbidden(res);

    const { amount, title, description, redirectUrl, usageLimit } = req.body;
    const updates = {
      amount: parseFloat(amount),
      title: title.trim(),
      description: description?.trim() || '',
      redirectUrl: redirectUrl?.trim() || '',
    };

    if (usageLimit !== undefined) {
      updates.usageLimit = usageLimit ? parseInt(usageLimit, 10) : null;
    }

    if (req.body.expiryDays !== undefined && req.body.expiryDays !== null && req.body.expiryDays !== '') {
      const days = parseInt(req.body.expiryDays, 10);
      updates.expiresAt = (days > 0) ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
    }

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update(updates);

    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_EDITED', {
      linkId,
      before: { amount: link.amount, title: link.title, description: link.description || '', redirectUrl: link.redirectUrl || '', expiresAt: link.expiresAt ?? null },
      after: { amount: updates.amount, title: updates.title, description: updates.description, redirectUrl: updates.redirectUrl, expiresAt: updates.expiresAt !== undefined ? updates.expiresAt : (link.expiresAt ?? null) },
    });

    return response.success(res, 'Payment link updated');
  } catch (err) {
    logger.error('Edit payment link error:', err.message);
    return response.serverError(res, err.message);
  }
};

const deletePaymentLink = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');

    const link = snap.val();
    if (link.userId !== req.user.uid) return response.forbidden(res);

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).remove();
    await subscriptionService.decrementLinkCount(link.userId);

    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_DELETED', { linkId, title: link.title, amount: link.amount });

    return response.success(res, 'Payment link deleted');
  } catch (err) {
    logger.error('Delete payment link error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disableLink = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');
    if (snap.val().userId !== req.user.uid) return response.forbidden(res);

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ status: 'disabled' });
    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_DISABLED', { linkId, title: snap.val().title });
    return response.success(res, 'Payment link disabled');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const enableLink = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');
    const link = snap.val();
    if (link.userId !== req.user.uid) return response.forbidden(res);
    if (link.expiresAt && Date.now() > link.expiresAt) return response.error(res, 'Cannot re-enable an expired link.');
    if (link.usageLimit && link.paymentCount >= link.usageLimit) return response.error(res, 'Cannot re-enable. Maximum usage limit reached.');

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ status: 'active' });
    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_ENABLED', { linkId, title: link.title });
    return response.success(res, 'Payment link enabled');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const createLinkValidation = [
  body('amount').isFloat({ min: 1, max: 2000 }).withMessage('Amount must be between ₹1 and ₹2,000'),
  body('title').notEmpty().withMessage('Title is required').isLength({ max: 80 }).trim(),
  body('description').optional().isLength({ max: 300 }).trim().escape(),
  body('redirectUrl').optional({ checkFalsy: true }).isURL({ require_protocol: true }).withMessage('Redirect URL must be a valid URL starting with http:// or https://').isLength({ max: 500 }),
  body('expiryDays').optional({ checkFalsy: false }).custom((v) => {
    if (v === '' || v === null || v === undefined) return true;
    const n = parseInt(v, 10);
    if (n === -1 || n === 0) return true;
    if (n >= 1 && n <= 3650) return true;
    throw new Error('Expiry must be -1 (never) or between 1 and 3650 days');
  }),
  body('usageLimit').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Usage limit must be at least 1'),
];

const editLinkValidation = createLinkValidation;

module.exports = {
  createPaymentLink,
  getUserLinks,
  getLinkPublic,
  getLinkOrderStatus,
  initiatePayment,
  disableLink,
  enableLink,
  editPaymentLink,
  deletePaymentLink,
  createLinkValidation,
  editLinkValidation,
};

},

// ===== services/gatewayModeService.js =====
"services/gatewayModeService.js": function (module, exports, __r) {
// services/gatewayModeService.js - ZapPay Gateway Test Mode / Live Mode
//
// A merchant can flip their account between LIVE (real Zap UPI Gateway, real
// money) and TEST (simulated checkout via test.html, no real money ever
// moves) from the Developer Portal. This service is the single source of
// truth for that toggle and for building the URL a customer gets sent to
// while a merchant is in test mode.
//
// Defaults to 'live' for every existing and new account so nothing about
// current production behaviour changes unless a merchant explicitly opts
// into 'test'.

const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");

const VALID_MODES = ['live', 'test'];

/**
 * Get a merchant's current gateway mode. Always resolves to 'live' or 'test'
 * (never throws, never returns undefined/null) so callers can branch on it
 * directly.
 */
async function getMode(uid) {
  const snap = await ref(`${DB_PATHS.USERS}/${uid}/gatewayMode`).once('value');
  return snap.val() === 'test' ? 'test' : 'live';
}

/**
 * Set a merchant's gateway mode. Throws on an invalid value so the calling
 * controller can turn that into a clean 400 response.
 */
async function setMode(uid, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid gateway mode: ${mode}`);
  }
  await ref(`${DB_PATHS.USERS}/${uid}`).update({
    gatewayMode: mode,
    gatewayModeUpdatedAt: serverTimestamp(),
  });
  return mode;
}

/**
 * The merchant-facing frontend's primary origin — same normalisation
 * zapService.js already uses for its own default success/failed URLs, kept
 * here too so gatewayTestController can build the same kind of fallback
 * redirect for test orders without duplicating the parsing logic.
 */
function getFrontendBase() {
  return (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Base URL that hosts the public storefront (root/store/index.html) —
 * deliberately NOT the same as FRONTEND_URL. FRONTEND_URL points at the
 * panel subdomain that serves pay.html/link.html; the storefront lives on
 * the root marketing domain instead (customer-facing, clean "YOUR-DOMAIN.com"
 * link). Override with STORE_URL if that ever needs to change; defaults to
 * the production root domain so nothing breaks if the env var is unset.
 */
function getStoreBase() {
  const raw = process.env.STORE_URL || 'https://YOUR-DOMAIN.com';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Base URL that hosts test.html. Defaults to FRONTEND_URL (the panel domain
 * that already serves pay.html/link.html) since test.html ships alongside
 * them there. Override with TEST_GATEWAY_URL if you'd rather host it
 * elsewhere (e.g. only on the marketing root domain).
 */
function getTestGatewayBase() {
  const raw = process.env.TEST_GATEWAY_URL || process.env.FRONTEND_URL || '';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Build the fake "payment_url" a test-mode order gets instead of a real Zap
 * UPI Gateway URL — customers land on our own simulator instead of a real
 * checkout page.
 *
 * This is the LEGACY simulator (test.html), still used by Payment Link and
 * Store test orders — those flows have their own page/UI and were not part
 * of the "test inside the merchant's own checkout page" change. ZapAPI
 * orders use buildCheckoutTestUrl() below instead.
 */
function buildTestPaymentUrl(orderId) {
  return `${getTestGatewayBase()}/test.html?order=${encodeURIComponent(orderId)}`;
}

module.exports = {
  getMode,
  setMode,
  buildTestPaymentUrl,
  getFrontendBase,
  getStoreBase,
};

},

// ===== services/amazonService.js =====
"services/amazonService.js": function (module, exports, __r) {
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
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const webhookService = __r("services/webhookService.js");
const notificationService = __r("services/notificationService.js");
const encryption = __r("utils/encryption.js");
const logger = __r("utils/logger.js");
const { ref } = __r("firebase/admin.js");
const { DB_PATHS, VERIFICATION_METHOD } = __r("config/constants.js");
const { fetchAmazonHistory } = __r("controllers/historyController.js");

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

},

// ===== services/webhookService.js =====
"services/webhookService.js": function (module, exports, __r) {
// services/webhookService.js
// Lets a merchant register one or more of THEIR OWN server URLs to be
// notified (via an outgoing POST) whenever one of their orders changes
// status — "Order pending" (created) and "Order success/failed" (settled).
// This is separate from ZapPay's own incoming webhook (webhooks/zapWebhook.js,
// which receives FROM the upstream ZapUPI gateway) — this service SENDS
// OUT to the merchant's own infrastructure instead.
const crypto = require('crypto');
const axios = require('axios');
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const subscriptionService = __r("services/subscriptionService.js");
const logger = __r("utils/logger.js");

const URL_RE = /^https:\/\/.+/i; // https-only — no plaintext http endpoints
const DELIVERY_TIMEOUT_MS = 8000;

/**
 * How many webhook URLs the given plan allows. -1 means unlimited
 * (Developer plan). Falls back to Blaze's limit if a plan is somehow
 * missing the field (shouldn't happen, but fails safe/restrictive rather
 * than accidentally granting unlimited).
 */
function getLimitForPlan(plan) {
  if (!plan) return 3;
  return typeof plan.webhookLimit === 'number' ? plan.webhookLimit : 3;
}

async function listWebhooks(uid) {
  const snap = await ref(`${DB_PATHS.WEBHOOKS}/${uid}`).once('value');
  if (!snap.exists()) return [];
  const val = snap.val();
  return Object.keys(val).map((id) => ({ id, ...val[id] })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Adds a new webhook URL for this user, enforcing their plan's limit.
 * Throws with a user-facing message on any validation/limit failure so
 * the controller can just forward err.message.
 */
async function addWebhook(uid, url) {
  const trimmed = String(url || '').trim();
  if (!URL_RE.test(trimmed)) {
    throw new Error('Webhook URL must start with https:// (plain http:// is not allowed).');
  }
  if (trimmed.length > 500) {
    throw new Error('Webhook URL is too long.');
  }

  const existing = await listWebhooks(uid);
  if (existing.some((w) => w.url === trimmed)) {
    throw new Error('This URL is already registered.');
  }

  const sub = await subscriptionService.getUserSubscription(uid);
  const limit = getLimitForPlan(sub.plan);
  if (limit !== -1 && existing.length >= limit) {
    throw new Error(`Your ${sub.plan.name} plan allows up to ${limit} webhook URL${limit === 1 ? '' : 's'}. Upgrade your plan to add more, or remove one first.`);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const record = {
    url: trimmed,
    isActive: true,
    createdAt: serverTimestamp(),
    lastTriggeredAt: null,
    lastStatus: null, // 'success' | 'failed' — result of the most recent delivery attempt
  };
  await ref(`${DB_PATHS.WEBHOOKS}/${uid}/${id}`).set(record);
  return { id, ...record };
}

async function deleteWebhook(uid, webhookId) {
  const webhookRef = ref(`${DB_PATHS.WEBHOOKS}/${uid}/${webhookId}`);
  const snap = await webhookRef.once('value');
  if (!snap.exists()) throw new Error('Webhook not found.');
  await webhookRef.remove();
}

async function toggleWebhook(uid, webhookId, isActive) {
  const webhookRef = ref(`${DB_PATHS.WEBHOOKS}/${uid}/${webhookId}`);
  const snap = await webhookRef.once('value');
  if (!snap.exists()) throw new Error('Webhook not found.');
  await webhookRef.update({ isActive: !!isActive });
}

/**
 * Fires a single delivery attempt to every ACTIVE webhook this user has
 * registered. Best-effort and fully isolated per-URL: one merchant's
 * unreachable/slow server can never affect another user's delivery, and a
 * delivery failure never throws back into the payment webhook flow that
 * called this (that flow's own correctness must never depend on the
 * merchant's own server being up). Every attempt updates lastTriggeredAt/
 * lastStatus so the merchant can see delivery health in Developer Portal.
 *
 * @param {string} uid
 * @param {'pending'|'success'|'failed'} event
 * @param {object} payload - order_id, amount, status, etc.
 */
async function notifyUserWebhooks(uid, event, payload) {
  let hooks;
  try {
    hooks = (await listWebhooks(uid)).filter((w) => w.isActive);
  } catch (err) {
    logger.error(`webhookService: failed to list webhooks for ${uid}: ${err.message}`);
    return;
  }
  if (!hooks.length) return;

  // If the customer used one of the merchant's promo codes, tell the merchant's
  // server the original price and the discount too (`amount` is what was paid).
  let promoFields = {};
  if (payload && payload.order_id) {
    try {
      const pSnap = await ref(`${DB_PATHS.PAYMENTS}/${payload.order_id}`).once('value');
      if (pSnap.exists() && pSnap.val().promoCode) {
        const p = pSnap.val();
        promoFields = { promo_code: p.promoCode, original_amount: p.originalAmount, discount: p.promoDiscount };
      }
    } catch (e) { /* enrichment is optional — never block a webhook on it */ }
  }

  const body = {
    event, // 'order.pending' | 'order.success' | 'order.failed'
    ...payload,
    ...promoFields,
    sent_at: Date.now(),
  };

  await Promise.all(hooks.map(async (hook) => {
    const hookRef = ref(`${DB_PATHS.WEBHOOKS}/${uid}/${hook.id}`);
    try {
      await axios.post(hook.url, body, {
        timeout: DELIVERY_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ZapPay-Webhook/1.0' },
        // Any 2xx counts as delivered; anything else (4xx/5xx) is a failed
        // delivery from ZapPay's point of view — don't throw for those,
        // classify them below instead of letting axios reject on non-2xx.
        validateStatus: () => true,
      }).then(async (res) => {
        const delivered = res.status >= 200 && res.status < 300;
        await hookRef.update({ lastTriggeredAt: Date.now(), lastStatus: delivered ? 'success' : 'failed' });
        if (!delivered) logger.warn(`Webhook delivery non-2xx (${res.status}) for ${uid} -> ${hook.url}`);
      });
    } catch (err) {
      // Network error, timeout, DNS failure, etc.
      try { await hookRef.update({ lastTriggeredAt: Date.now(), lastStatus: 'failed' }); } catch (e) {}
      logger.warn(`Webhook delivery failed for ${uid} -> ${hook.url}: ${err.message}`);
    }
  }));
}

module.exports = {
  getLimitForPlan,
  listWebhooks,
  addWebhook,
  deleteWebhook,
  toggleWebhook,
  notifyUserWebhooks,
};

},

// ===== utils/encryption.js =====
"utils/encryption.js": function (module, exports, __r) {

// utils/encryption.js
const crypto = require('crypto');

// ENCRYPTION_KEY hamesha 32 characters ki honi chahiye
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; 
const IV_LENGTH = 16;

module.exports = {
  encrypt: (text) => {
    if (!text) return text;
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  },
  
  decrypt: (text) => {
    if (!text) return text;
    // Agar text already plain text hai (jaise pehle save hua tha), toh wahi return karega error nahi dega
    if (!text.includes(':')) return text; 
    
    try {
      let textParts = text.split(':');
      let iv = Buffer.from(textParts.shift(), 'hex');
      let encryptedText = Buffer.from(textParts.join(':'), 'hex');
      let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch (e) {
      console.error('Decryption failed:', e);
      return null;
    }
  }
};

},

// ===== controllers/historyController.js =====
"controllers/historyController.js": function (module, exports, __r) {
// controllers/historyController.js
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

// All FamPay email times are IST. Server (Vercel) runs in UTC, so every
// conversion below is done explicitly against IST (+05:30) instead of
// relying on the server's local timezone.
const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "4:43 PM IST, 8 Oct 2026" -> real epoch ms (start of that minute)
function parseIstEmailTime(str) {
  if (!str) return null;
  const m = str.replace(/IST/i, '').match(/(\d{1,2}):(\d{2})\s*([AP])M\s*,?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  const mon = MONTH_IDX[m[5].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  return Date.UTC(parseInt(m[6], 10), mon, parseInt(m[4], 10), h, parseInt(m[2], 10)) - IST_OFFSET_MS;
}

// epoch ms -> "DD-MM-YYYY HH:mm:ss" in IST
function formatDate(ts) {
  const d = new Date(ts + IST_OFFSET_MS);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Core IMAP fetch + parse, as a plain reusable function — connects to
 * the given mailbox, reads up to `limit` of the newest emails, and
 * extracts whatever looks like a FamPay payment-received notification
 * from each one.
 *
 * THIS is the single source of truth for "what a FamPay payment email
 * says" — both the merchant-facing "Live Email History" sync
 * (fetchHistory below, called via POST /api/history/fetch) and the
 * backend auto-verifier (services/fampayService.js) call this same
 * function, so they can never silently disagree about what's in the
 * mailbox. Previously they didn't: fampayService.js was calling a
 * function named `fetchFamPayHistory` that this file never actually
 * exported (only the differently-shaped, req/res-based `fetchHistory`
 * existed) — every verification attempt was throwing
 * "fetchFamPayHistory is not a function", getting caught, and silently
 * returning false, no matter how correct the matching logic around it
 * was. That mismatch, not any matching-logic bug, was the real cause of
 * "payment genuinely went through, verification says no" across every
 * attempt before this one.
 *
 * Returns { status: true, data: [...] } on success (data possibly
 * empty), or { status: false, error } if the mailbox couldn't be read
 * at all (bad credentials, connection failure, etc.) — callers must
 * treat `status: false` as "couldn't check", not "no payment found".
 */
async function fetchFamPayHistory(email, pass, limit = 15, opts = {}) {
  const fetchLimit = Math.min(Math.max(limit, 1), 50);

  const config = {
    imap: {
      user: email,
      password: pass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection;
  try {
    connection = await imap.connect(config);
    await connection.openBox('INBOX');

    // Two-phase fetch, mirroring the original purchased history.php
    // script's approach (which this Node version had drifted from and
    // was MUCH slower and less accurate for it):
    //
    // Phase 1 — a server-side-filtered, header-only search for
    // `SUBJECT "FamX account"` (the exact subject line FamPay's own
    // payment-received emails use). This is fast: Gmail's IMAP server
    // does the filtering and only returns matching UIDs + light
    // metadata, not any message content.
    //
    // Phase 2 — only the `fetchLimit` (default 15) most recent UIDs
    // from that filtered set get their full body fetched and parsed.
    //
    // The previous version searched `ALL` mail with `bodies: ['']` —
    // which, with imap-simple, fetches the FULL BODY of every single
    // message in the search result as part of the search call itself,
    // BEFORE any sorting/limiting happens. For any Gmail account with
    // more than a handful of emails ever (this account alone has
    // years of history), that meant downloading and parsing the
    // complete body of every message in the inbox on every single
    // call — easily tens of seconds to minutes, which is exactly why
    // this was timing out. It was also less accurate: without the
    // subject filter, the "does this look like a FamPay email" check
    // further down was a loose heuristic (any email mentioning
    // "received" and a rupee amount), which could pick up completely
    // unrelated emails.
    // SPEED: only look at recent mail (IMAP SINCE is day-granular, so go
    // back 1 extra day) instead of headers of every FamPay email ever
    // received, then fetch all needed bodies in ONE round trip and parse
    // them in parallel (was: one sequential IMAP round trip per email).
    const searchCriteria = [['SUBJECT', 'FamX account']];
    if (opts.sinceMs) searchCriteria.push(['SINCE', new Date(opts.sinceMs - 24 * 60 * 60 * 1000)]);
    const searchResults = await connection.search(searchCriteria, { bodies: ['HEADER'], struct: false, markSeen: false });
    searchResults.sort((a, b) => b.attributes.uid - a.attributes.uid);
    const limitedUids = searchResults.slice(0, fetchLimit).map((item) => item.attributes.uid);

    const parsedTransactions = [];

    let fetchedItems = [];
    if (limitedUids.length > 0) {
      fetchedItems = await connection.search([['UID', limitedUids.join(',')]], { bodies: [''], struct: true, markSeen: false });
      fetchedItems.sort((a, b) => b.attributes.uid - a.attributes.uid);
    }
    const parsedMails = await Promise.all(fetchedItems.map(async (item) => {
      const all = item.parts.find(part => part.which === '');
      if (!all) return null;
      try { return await simpleParser(all.body); } catch (e) { return null; }
    }));

    for (const mail of parsedMails) {
      if (!mail) continue;
      const subject = mail.subject || '';
      const body = mail.text || '';
      const dateFallback = mail.date;

      let amount = null, sender = 'NA', txn_id = 'NA', utr = 'NA', purpose = 'NA', txn_time = null, balance = null;

      const amtSubjMatch = subject.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
      if (amtSubjMatch) amount = parseFloat(amtSubjMatch[1].replace(/,/g, ''));

      // Account balance-after-transaction, as the original purchased
      // history.php script extracted it (e.g. "...your balance is
      // ₹59..."). Lost when this function replaced that PHP script —
      // this object never carried a `balance` field, which is exactly
      // why the FamPay Connect page's "FamPay Balance" stat went blank
      // even though everything else kept working.
      const balanceMatch = body.match(/balance\s+is\s+(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/i);
      if (balanceMatch) balance = parseFloat(balanceMatch[1].replace(/,/g, ''));

      const amtBodyMatch = body.match(/received\s+(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/i);
      if (amtBodyMatch) amount = parseFloat(amtBodyMatch[1].replace(/,/g, ''));

      const senderMatch = body.match(/from\s+([A-Za-z][A-Za-z0-9\s]{1,40}?)\s+at\s+\d/i);
      if (senderMatch) sender = senderMatch[1].trim();

      // Matches both "Transaction ID FMPIB..." (full prose, as seen in
      // some FamPay email bodies) and the app's own shorter "TXN ID:
      // FMPIB..." label — the earlier version of this regex only
      // matched the former, so FamPay-to-FamPay instant transfers
      // (which this account/app uses "TXN ID" for) were silently
      // parsed as txn_id: 'NA' even though the Live Email History UI,
      // which reads the same mailbox, clearly shows a TXN value for
      // them. "UTR" is intentionally excluded from this pattern so it
      // doesn't double-match the separate utr field below.
      const txnIdMatch = body.match(/\b(?:transaction\s*id|txn\s*\.?\s*id)[:\s]+([A-Z0-9]+)/i);
      if (txnIdMatch) txn_id = txnIdMatch[1];

      const utrMatch = body.match(/UTR[:\s]+(\d+)/i);
      if (utrMatch) utr = utrMatch[1];

      const timeMatch = body.match(/at\s+(\d{1,2}:\d{2}\s*[AP]M\s*IST,?\s*\d{1,2}\s+\w+\s+\d{4})/i);
      if (timeMatch) txn_time = timeMatch[1].trim();

      let finalDatetime = 'NA';
      let ts = null; // real epoch ms of the payment (minute precision when from body)
      if (txn_time) {
        ts = parseIstEmailTime(txn_time);
      }
      const mailTs = (dateFallback && !isNaN(new Date(dateFallback).getTime())) ? new Date(dateFallback).getTime() : null;
      if (ts === null && mailTs !== null) ts = mailTs;
      if (ts !== null) finalDatetime = formatDate(ts);

      if (amount && (subject.toLowerCase().includes('fam') || body.toLowerCase().includes('fam') || body.toLowerCase().includes('received'))) {
        parsedTransactions.push({ name: sender, utr, datetime: finalDatetime, ts, mailTs, amount, purpose, txn_id, balance });
      }
    }

    connection.end();
    return { status: true, data: parsedTransactions };
  } catch (error) {
    try { connection && connection.end(); } catch (_) {}
    logger.error('fetchFamPayHistory error:', error.message);
    return { status: false, error: error.message, data: [] };
  }
}

/**
 * POST /api/history/fetch — the merchant-facing "Live Email History"
 * sync button on the FamPay Connect page. Thin wrapper around
 * fetchFamPayHistory() above, plus the existing auto-sync-against-
 * pending-orders side effect (unchanged from before).
 */
const fetchHistory = async (req, res) => {
  const { email, pass, limit = 15 } = req.body;
  const userId = req.user?.uid;

  if (!email || !pass) {
    return response.error(res, 'Email and App Password are required.', 400);
  }

  const result = await fetchFamPayHistory(email, pass, limit);

  if (!result.status) {
    let friendlyError = 'Connection failed. Please check your credentials.';
    const errStr = (result.error || '').toLowerCase();
    if (errStr.includes('authenticationfailed') || errStr.includes('invalid credentials')) {
      friendlyError = 'Invalid App Password. Please check your Google App Password.';
    }
    return response.error(res, friendlyError);
  }

  const parsedTransactions = result.data;

  try {
    if (userId && parsedTransactions.length > 0) {
      const allOrdersSnap = await ref(DB_PATHS.PAYMENTS).orderByChild('userId').equalTo(userId).once('value');
      const usedIdentifiers = new Set();
      const pendingOrders = [];

      if (allOrdersSnap.exists()) {
        allOrdersSnap.forEach(child => {
          const o = child.val();
          if (o.status === 'success') {
            if (o.utr && o.utr !== 'NA') usedIdentifiers.add(o.utr);
            if (o.txn_id && o.txn_id !== 'NA') usedIdentifiers.add(o.txn_id);
          } else if (o.status === 'pending') {
            pendingOrders.push({ id: child.key, ...o });
          }
        });
      }

      const availableTransactions = parsedTransactions.filter(tx => {
        const hasUtr = tx.utr !== 'NA' && usedIdentifiers.has(tx.utr);
        const hasTxn = tx.txn_id !== 'NA' && usedIdentifiers.has(tx.txn_id);
        return !hasUtr && !hasTxn;
      });

      for (const order of pendingOrders) {
        const matchIndex = availableTransactions.findIndex(tx => parseFloat(tx.amount) === parseFloat(order.amount));

        if (matchIndex !== -1) {
          const match = availableTransactions[matchIndex];
          availableTransactions.splice(matchIndex, 1); // Mark as used

          await firebaseService.updatePaymentStatus(order.id, {
            status: 'success',
            txn_id: match.txn_id !== 'NA' ? match.txn_id : 'AUTO_SYNC',
            utr: match.utr !== 'NA' ? match.utr : 'AUTO_SYNC',
            payerName: match.name !== 'NA' ? match.name : null,
            environment: 'email_auto_sync'
          });

          try {
            const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');
            const plan = subSnap.val()?.plan || { walletLimit: 500 };
            const balance = await walletService.getBalance(userId);
            const available = plan.walletLimit - balance;

            const credit = Math.min(order.amount, available);
            if (credit > 0) {
              await walletService.creditWallet(userId, credit, `Auto-Sync FamPay Order ${order.id}`);
            }

            const commissionPct = order.commissionPercent ?? plan.commissionPercent ?? 5;
            const creditCost = Math.round((order.amount * commissionPct) / 100 * 100) / 100;
            if (creditCost > 0) {
              try {
                await walletService.debitZapCredit(userId, creditCost, `Commission for Order ${order.id}`);
              } catch (e) {
                logger.error(`Zap Credit debit failed for already-verified order ${order.id}: ${e.message}`);
              }
            }
          } catch (e) {
            logger.error('Error crediting wallet during auto-sync:', e.message);
          }
        }
      }
    }
  } catch (e) {
    logger.error('fetchHistory auto-sync side effect error:', e.message);
  }

  return response.success(res, 'History synced', parsedTransactions);
};

// ─────────────────────────────────────────────────────────────────────
// AMAZON PAY WALLET — "You have added ₹X successfully to your Amazon Pay
// Wallet" notification emails (sender: Amazon Pay India).
//
// Unlike FamPay, this email states only an "Order Date" (no time of day),
// so the payment's timestamp is the email's own Date header — second
// precision, and always AFTER the payment itself. That is what lets the
// verifier reject any email that arrived before an order was created.
// ─────────────────────────────────────────────────────────────────────
// Only Amazon's own mail domains are trusted (stops look-alike senders such as
// amazon-fake.com from forging a wallet-credit email). Extend here if Amazon
// ever sends from another domain.
const AMAZON_SENDER_DOMAIN_RE = /(^|\.)(amazon|amazonpay)\.(in|com)$/i;

function amazonMailText(mail) {
  let t = mail.text || '';
  if (!t && mail.html) {
    t = String(mail.html)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|td|li|h\d)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#8377;/g, '₹');
  }
  return t.replace(/\s+/g, ' ').trim();
}

// Returns a normalized transaction, or null if this isn't a genuine
// Amazon Pay wallet-credit email (wrong sender, wrong shape, or missing
// any field verification depends on).
function parseAmazonMail(mail) {
  const fromAddr = String(mail.from?.value?.[0]?.address || '').toLowerCase();
  const domain = fromAddr.split('@')[1] || '';
  if (!AMAZON_SENDER_DOMAIN_RE.test(domain)) return null;

  const flat = amazonMailText(mail);
  if (!/Amazon Pay Wallet/i.test(flat) || !/UPI Reference ID/i.test(flat) || !/You have added/i.test(flat)) return null;

  // The deposited amount is ONLY the one in "You have added ₹X" — never
  // the "Updated Amazon Pay Balance" / Wallet / Gift Cards figures.
  const am = flat.match(/You have added\s*(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
  const ut = flat.match(/UPI Reference ID\s*[:\-]?\s*(\d{8,})/i);
  if (!am || !ut) return null;

  const mailTs = mail.date && !isNaN(new Date(mail.date).getTime()) ? new Date(mail.date).getTime() : null;
  if (mailTs === null) return null; // no usable timestamp => can't prove it isn't stale

  const od = flat.match(/Order Date\s*[:\-]?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const bal = flat.match(/Updated Amazon Pay Balance\s*(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);

  return {
    name: 'Amazon Pay',
    utr: ut[1],
    txn_id: ut[1],
    datetime: formatDate(mailTs),
    ts: mailTs,
    mailTs,
    tsPrecisionMs: 0, // exact (email Date header), unlike FamPay's minute-only time
    amount: parseFloat(am[1].replace(/,/g, '')),
    purpose: 'Amazon Pay Wallet',
    balance: bal ? parseFloat(bal[1].replace(/,/g, '')) : null,
    orderDate: od ? od[1] : null,
  };
}

/**
 * Amazon Pay counterpart of fetchFamPayHistory — same contract:
 * { status: true, data: [newest-first transactions] } or
 * { status: false, error } when the mailbox couldn't be read at all.
 */
async function fetchAmazonHistory(email, pass, limit = 15, opts = {}) {
  const fetchLimit = Math.min(Math.max(limit, 1), 50);
  const config = {
    imap: {
      user: email, password: pass, host: 'imap.gmail.com', port: 993, tls: true,
      authTimeout: 10000, tlsOptions: { rejectUnauthorized: false },
    },
  };

  let connection;
  try {
    connection = await imap.connect(config);
    await connection.openBox('INBOX');

    const criteria = [['OR', ['SUBJECT', 'added to your Amazon Pay Wallet'], ['SUBJECT', 'You have added']]];
    if (opts.sinceMs) criteria.push(['SINCE', new Date(opts.sinceMs - 24 * 60 * 60 * 1000)]);

    const found = await connection.search(criteria, { bodies: ['HEADER'], struct: false, markSeen: false });
    found.sort((a, b) => b.attributes.uid - a.attributes.uid);
    const uids = found.slice(0, fetchLimit).map((it) => it.attributes.uid);

    let items = [];
    if (uids.length > 0) {
      items = await connection.search([['UID', uids.join(',')]], { bodies: [''], struct: true, markSeen: false });
      items.sort((a, b) => b.attributes.uid - a.attributes.uid);
    }
    const mails = await Promise.all(items.map(async (item) => {
      const all = item.parts.find((part) => part.which === '');
      if (!all) return null;
      try { return await simpleParser(all.body); } catch (e) { return null; }
    }));

    const data = [];
    for (const mail of mails) {
      if (!mail) continue;
      const tx = parseAmazonMail(mail);
      if (tx) data.push(tx);
    }
    data.sort((a, b) => b.ts - a.ts);

    connection.end();
    return { status: true, data };
  } catch (error) {
    try { connection && connection.end(); } catch (_) {}
    logger.error('fetchAmazonHistory error:', error.message);
    return { status: false, error: error.message, data: [] };
  }
}

module.exports = { fetchHistory, fetchFamPayHistory, fetchAmazonHistory, parseAmazonMail };


},

// ===== services/fampayService.js =====
"services/fampayService.js": function (module, exports, __r) {
// services/fampayService.js
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const webhookService = __r("services/webhookService.js");
const notificationService = __r("services/notificationService.js");
const encryption = __r("utils/encryption.js");
const logger = __r("utils/logger.js");
const { ref } = __r("firebase/admin.js");
const { DB_PATHS, VERIFICATION_METHOD } = __r("config/constants.js");
const { fetchFamPayHistory } = __r("controllers/historyController.js");

// FamPay's email text only ever states the time as "H:MM AM/PM" — never
// seconds (historyController.js's regex has no seconds group because
// the email genuinely doesn't include one). So a parsed txnTime is
// really the START of that minute, not an exact instant: the real
// payment could have happened anywhere in [txnTime, txnTime+59.999s].
// STRICT creation-time guard. A transaction can only pay this order if
// it happened at/after the order was created.
//  - txn.ts   = real epoch of the payment (FamPay states only the minute,
//               so the payment lies in [ts, ts+59.999s]); computed in IST
//               in historyController.js (NOT server-local time).
//  - txn.mailTs = the email's own Date header (second precision). An email
//               that arrived before the order existed can never be its payment.
// Missing/unparseable time => rejected (never assumed fresh).
const EMAIL_MINUTE_PRECISION_MS = 60 * 1000;
function isTxnAfterOrder(txn, orderCreatedAt) {
  if (!orderCreatedAt || !txn || typeof txn.ts !== 'number') return false;
  if (txn.ts + EMAIL_MINUTE_PRECISION_MS - 1 < orderCreatedAt) return false;
  if (typeof txn.mailTs === 'number' && txn.mailTs < orderCreatedAt) return false;
  return true;
}

// Previously an HTTP round-trip to https://YOUR-DOMAIN.com/history.php (a
// PHP script using the imap_* extension, which does not exist on
// Vercel's serverless runtime — see historyController.js for the full
// migration note). Now an in-process call — same parsing logic, one
// fewer network hop, and no dependency on that PHP file's continued
// existence at all.

// Hard ceiling on how late a payment can still be reconciled against a
// cancelled/timeout order — see the status guard below. Keeps a payment
// made minutes after checkout expired from being lost, without leaving
// every cancelled order checkable forever (a customer could otherwise
// pay a months-old, long-abandoned order and still have it go through).
const LATE_RECONCILE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────
// WHY MATCHING IS "LATEST EMAIL + AMOUNT + A SINGLE ONE-SIDED TIME
// GUARD" AND NOTHING FANCIER
// ─────────────────────────────────────────────────────────────────────
// Earlier versions compared a transaction's email timestamp against the
// order's creation timestamp on BOTH sides (too-early AND too-late),
// with various buffers for clock skew and FamPay's emails only stating
// whole minutes, never seconds. That kept producing false rejections
// for genuinely successful payments.
//
// The very next version went too far the other way and dropped time
// entirely — which then let a stale, already-sitting-in-the-inbox email
// (very easy to end up with: this account alone has many separate ₹1
// test transactions from testing this exact feature) wrongly verify a
// brand-new, unrelated order of the same amount, including ones from
// BEFORE the order even existed. Not acceptable.
//
// This version keeps the useful part of each — the single-latest-email
// simplicity, AND a time check — but only enforces the direction that
// actually matters for correctness: an email from before this order was
// created can NEVER be what paid for it, full stop. There's no matching
// upper-bound check here (a payment arriving late within the order's
// own lifetime is still fine; LATE_RECONCILE_WINDOW_MS below also
// already bounds how long any of this keeps running at all), so this
// doesn't reintroduce the false-rejection problem from the first
// version — it only closes the specific "verified against an email that
// predates the order" hole.
//
//   - getPublicOrderStatus (developerController.js) now re-triggers this
//     check at most every 5 seconds while an order is pending/ambiguous
//     — in effect, the mailbox is "live-synced" every 5s for the
//     duration of the order, same idea as the merchant's own "Live
//     Email History" sync on the FamPay Connect page, just running
//     silently in the background for this one order instead of being a
//     manual button.
//   - Only the NEWEST email FamPay has sent (historyController.js
//     already returns transactions newest-first) is ever considered a
//     candidate — not a backlog of the last 15. This is what keeps
//     "amount-only, no time check" safe: an old, unrelated, same-amount
//     transaction sitting further back in the inbox is never looked at,
//     only whatever just arrived.
//   - The order's own lifetime (3 or 8 minutes, set by Admin Settings'
//     "Amount + Time Verification Mode" — see checkoutUrlBuilder.js) is
//     still what bounds how long this checking happens at all: once the
//     checkout page's countdown ends, cancelOrder() marks the order
//     'cancelled'/'timeout' and this function stops being called for it
//     (barring the LATE_RECONCILE_WINDOW_MS grace below).
//   - Reuse protection (an identifier already claimed by a different
//     order) and the ambiguous-match guard (more than one open order of
//     the same amount for the same mailbox right now) are UNCHANGED —
//     removing time checks doesn't touch either of those.
const verifyPayment = async (orderId) => {
  const startedAt = Date.now();
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    // Real-world gap this closes: a customer's UPI app fails on first
    // attempt (e.g. a "₹2,000 gallery-scan limit" popup from the UPI app
    // itself — a client-side app restriction, not a ZapPay bug), they
    // retry by a different method (QR download → gallery scan), and that
    // retry succeeds — but takes long enough that this order's checkout
    // timer already expired and cancelOrder() (developerController.js)
    // had already marked it 'cancelled'/'timeout'. The money is real and
    // already sitting in the merchant's FamPay account; without this,
    // nothing ever checks this order again and that payment is silently
    // orphaned. A cancelled/timeout order is only reconsidered within
    // LATE_RECONCILE_WINDOW_MS of when it was last updated (i.e. when it
    // was cancelled) — a genuinely abandoned order from hours/days ago
    // stays cancelled.
    const isLateReconcile = payment.status === 'cancelled' || payment.status === 'timeout';
    // 'ambiguous' orders stay re-checkable exactly like 'pending': a
    // sibling order that was blocking a deterministic match may have
    // resolved since the last poll (paid, cancelled, or manually
    // UTR-verified), which can turn yesterday's "can't tell which
    // order" into "only one candidate left now".
    const isRecheckable = payment.status === 'pending' || payment.status === 'ambiguous';
    if (!isRecheckable && !isLateReconcile) return false;
    if (isLateReconcile) {
      const cancelledAt = typeof payment.updatedAt === 'number' ? payment.updatedAt : Date.parse(payment.updatedAt) || 0;
      if (Date.now() - cancelledAt > LATE_RECONCILE_WINDOW_MS) return false;
    }

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const [user, settings] = await Promise.all([firebaseService.getUser(verifyUid), firebaseService.getSettings()]);
    if (!user || !user.fampay || !user.fampay.isConnected) return false;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return false;

    // Still read here purely to label which method produced a match
    // (AUTO_PURPOSE vs AUTO_AMOUNT_TIME) for the Admin Panel's
    // Verification Log — it no longer changes any matching behavior
    // itself (see the big comment block above this function).
    const amountTimeMode = !!settings.amountTimeVerificationMode;
    const verificationMode = amountTimeMode ? 'AMOUNT_TIME' : 'NORMAL';

    const createdAtMs = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const historyResult = await fetchFamPayHistory(user.fampay.email, rawPassword, 5, { sinceMs: createdAtMs });

    // historyController's fetchFamPayHistory() keeps the exact same
    // field name history.php used ("status", not "success") — this
    // check always rejected a genuinely successful response before
    // ever reaching the match below.
    if (!historyResult || !historyResult.status) return false;

    const transactions = historyResult.data || [];
    if (transactions.length === 0) return false;

    // Newest-first list. Pick the newest transaction that has the same
    // amount AND happened at/after this order's creation. Anything older
    // than the order is ignored completely.
    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const latest = transactions.find((t) => parseFloat(t.amount) === paymentAmount && isTxnAfterOrder(t, orderCreatedAt));
    if (!latest) return false;
    const txnAmount = parseFloat(latest.amount);

    // Normal Mode only, kept exactly as before: FamX often echoes its
    // own "ZP<orderId>"-style reference in the payment note. Not
    // required (FamPay-to-FamPay transfers frequently have no purpose
    // text at all) — but if purpose IS present and does NOT contain
    // this order's id, that's a strong sign the email belongs to a
    // different order, so it's rejected rather than trusted on amount
    // alone. Amount+Time Mode never looks at purpose at all.
    let verificationMethod = VERIFICATION_METHOD.AUTO_AMOUNT_TIME;
    if (!amountTimeMode) {
      if (latest.purpose && latest.purpose !== 'NA' && !latest.purpose.includes(orderId)) return false;
      verificationMethod = (latest.purpose && latest.purpose !== 'NA')
        ? VERIFICATION_METHOD.AUTO_PURPOSE
        : VERIFICATION_METHOD.AUTO_AMOUNT_TIME;
    }

    const txnIdentifier = (latest.utr && latest.utr !== 'NA') ? latest.utr : latest.txn_id;
    if (txnIdentifier && txnIdentifier !== 'NA') {
      const existingCheck = await firebaseService.getPaymentByUtr(txnIdentifier);
      if (existingCheck && existingCheck.orderId !== orderId) {
        // This exact email has already been claimed by a different
        // order — never let the same payment confirm two orders.
        return false;
      }
    }

    // ── Ambiguous-match guard ──────────────────────────────────────
    // Without a time window to narrow things down, two still-open
    // orders of the same amount for the same mailbox would otherwise
    // both look like valid matches for this one email. Rather than
    // guess, every other currently pending/ambiguous order for this
    // mailbox is counted; if more than this one shares the amount,
    // leave it AMBIGUOUS instead of auto-verifying either — manual UTR
    // entry stays available to resolve it deterministically.
    const siblingsSnap = await ref(DB_PATHS.PAYMENTS)
      .orderByChild('fampayVerifyUid')
      .equalTo(verifyUid)
      .once('value');
    let candidateCount = 0;
    if (siblingsSnap.exists()) {
      siblingsSnap.forEach((child) => {
        const o = child.val();
        if ((o.status === 'pending' || o.status === 'ambiguous') && parseFloat(o.amount) === txnAmount) {
          candidateCount++;
        }
      });
    }
    if (candidateCount > 1) {
      if (payment.status !== 'ambiguous') {
        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ status: 'ambiguous', updatedAt: Date.now() });
      }
      await firebaseService.logVerificationAttempt({
        orderId,
        amount: txnAmount,
        paymentTime: latest.datetime,
        utrMasked: firebaseService.maskIdentifier(txnIdentifier),
        verificationMethod: VERIFICATION_METHOD.AUTO_AMOUNT_TIME,
        verificationMode,
        result: 'AMBIGUOUS',
        reason: 'Multiple currently-open orders share this amount for the same mailbox',
        processingTimeMs: Date.now() - startedAt,
      });
      return false;
    }

    // Sender name as FamPay's own email stated it (historyController.js's
    // `name` field, parsed from "... received ₹X from <Name> at ...").
    // Surfaced on the checkout page's success popup so it's clear who the
    // money actually came from. Never guessed/defaulted — left out
    // entirely when the email didn't have a usable name.
    const payerName = (latest.name && latest.name !== 'NA') ? latest.name : null;

    logger.info(`FamPay Match Found for Order ${orderId}! UTR: ${latest.utr}${isLateReconcile ? ' (late reconciliation — order was ' + payment.status + ')' : ''}`);

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: 'success',
      utr: latest.utr,
      txnId: latest.txn_id || latest.utr,
      payerName,
      updatedAt: Date.now()
    });

    // ─── Wallet credit (routing-dependent) ────────────────────────
    // Three routingEngine values reach this function: 'system_cashier',
    // 'cashier', and 'wallet' (see paymentLinkController/paymentController/
    // storeController/developerController/subscriptionController for
    // where each is set).
    //
    // - system_cashier: ZapPay's own pooled FamPay collects the money —
    //   it genuinely passes through ZapPay, so it must be credited to
    //   the merchant's Zap Cash wallet (capped at walletLimit).
    // - wallet: same — money genuinely lands in a ZapPay-controlled
    //   account, so it's credited the same way.
    // - cashier: the merchant's OWN connected FamPay account collects
    //   the money directly — it's already sitting in their own FamPay/
    //   bank, never touching ZapPay. Crediting Zap Cash here would be a
    //   real duplicate: the merchant would have the money in their own
    //   account AND a matching ZapPay wallet balance they could then
    //   withdraw — a double-payout. So 'cashier' must NEVER credit
    //   Zap Cash; only the Zap Credit commission below applies, and
    //   incrementPaymentLinkStats (for the Paid-count/collected total)
    //   still runs regardless, since that's just a record, not money
    //   movement.
    const subscriptionService = __r("services/subscriptionService.js");
    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${payment.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };

    if (payment.routingEngine === 'cashier') {
      logger.info(`Order ${orderId}: genuine cashier routing — money already in merchant's own FamPay, skipping Zap Cash credit.`);
    } else {
      try {
        const balance = await walletService.getBalance(payment.userId);
        const available = plan.walletLimit - balance;

        const credit = Math.min(txnAmount, available);
        if (credit > 0) {
          await walletService.creditWallet(payment.userId, credit, `Order ${orderId}`);
        }
      } catch (e) {
        logger.error(`Error crediting wallet for ${payment.routingEngine}: ${e.message}`);
      }
    }

    // ─── Zap Credit deduction (unconditional) ─────────────────────
    // Commission is owed on every successful order regardless of
    // routing engine — cashier or direct wallet, doesn't matter.
    // Never blocks the payment itself: a failed debit here (e.g.
    // insufficient Zap Credit) is logged, not thrown, since the
    // customer has already paid and the merchant's wallet is
    // already credited by this point.
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
      order_id: orderId,
      status: 'success',
      amount: txnAmount,
      utr: latest.utr,
      payer_name: payerName,
    }).catch(() => {});

    if (payment.linkId) {
      await firebaseService.incrementPaymentLinkStats(payment.linkId, txnAmount);
    }

    let title = isLateReconcile ? '💰 Late Payment Reconciled' : '💰 Payment Received via FamPay';
    let message = isLateReconcile
      ? `₹${txnAmount} arrived after checkout had expired and was still matched to Order: ${orderId}. Wallet credited normally.`
      : `₹${txnAmount} received${payerName ? ' from ' + payerName : ''} in your FamPay account. Order: ${orderId}`;
    if (payment.storeId && payment.productId) {
      try {
        const productSnap = await ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`).once('value');
        const productData = productSnap.val();
        if (productData) {
          title = '🛍️ Product Sold!';
          message = `"${productData.title || 'Product'}" sold for ₹${txnAmount} via FamPay. Order: ${orderId}`;
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
      message = `₹${txnAmount} received${payerName ? ' from ' + payerName : ''} via your payment link (FamPay). Order: ${orderId}`;
    }

    await notificationService.createNotification(payment.userId, {
      title, message, type: 'payment',
    });

    await firebaseService.logVerificationAttempt({
      orderId,
      amount: txnAmount,
      paymentTime: latest.datetime,
      utrMasked: firebaseService.maskIdentifier(txnIdentifier),
      verificationMethod,
      verificationMode,
      result: 'VERIFIED',
      reason: verificationMethod === VERIFICATION_METHOD.AUTO_PURPOSE
        ? 'Amount matched the latest mailbox email and Note/Purpose corroborated it'
        : 'Amount matched the latest mailbox email',
      processingTimeMs: Date.now() - startedAt,
    });

    return true;
  } catch (err) {
    logger.error(`Fampay verification error for ${orderId}: ${err.message}`);
    return false;
  }
};

async function checkUtrForOrder(orderId, identifier) {
  const startedAt = Date.now();
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.fampay || !user.fampay.isConnected) return false;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return false;

    const settings = await firebaseService.getSettings();
    const verificationMode = settings.amountTimeVerificationMode ? 'AMOUNT_TIME' : 'NORMAL';

    const historyResult = await fetchFamPayHistory(user.fampay.email, rawPassword, 20);
    // Same field-name contract as verifyPayment above — historyResult
    // uses "status", not "success".
    if (!historyResult || !historyResult.status) return false;

    const transactions = historyResult.data || [];
    const paymentAmount = parseFloat(payment.amount);
    const identifierTrimmed = identifier.trim();

    // Manual entry: the user typed a SPECIFIC identifier, which is
    // already a strong, precise signal on its own — unlike the
    // amount-only auto-check above, there's no "which transaction is
    // this" ambiguity to resolve, so the full recently-fetched batch is
    // searched (not just the latest email) and no time window is
    // applied at all.
    for (const txn of transactions) {
      const txnAmount = parseFloat(txn.amount);
      const utrMatch = (txn.utr === identifierTrimmed);
      const txnIdMatch = (txn.txn_id === identifierTrimmed);

      if ((utrMatch || txnIdMatch) && txnAmount === paymentAmount) {
        if (txn.utr && txn.utr !== 'NA') {
          const existingUtrCheck = await firebaseService.getPaymentByUtr(txn.utr);
          if (existingUtrCheck && existingUtrCheck.orderId !== orderId) continue;
        }
        if (txn.txn_id && txn.txn_id !== 'NA') {
          const existingTxnCheck = await firebaseService.getPaymentByTxnId(txn.txn_id);
          if (existingTxnCheck && existingTxnCheck.orderId !== orderId) continue;
        }

        const payerName = (txn.name && txn.name !== 'NA') ? txn.name : null;
        if (payerName) {
          await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ payerName });
        }

        await firebaseService.logVerificationAttempt({
          orderId,
          amount: txnAmount,
          paymentTime: txn.datetime,
          utrMasked: firebaseService.maskIdentifier(identifierTrimmed),
          verificationMethod: VERIFICATION_METHOD.MANUAL_UTR,
          verificationMode,
          result: 'VERIFIED',
          reason: 'User-submitted UTR/Txn ID matched a mailbox record',
          processingTimeMs: Date.now() - startedAt,
        });

        return true;
      }
    }
    return false;
  } catch (err) {
    logger.error(`checkUtrForOrder error for ${orderId}: ${err.message}`);
    return false;
  }
}

/**
 * Non-mutating "what does the mailbox say right now" peek, for the
 * checkout page's manual "Refresh if payment not verified" button.
 * Deliberately returns something ONLY when the mailbox's single latest
 * email's amount equals THIS order's amount ("same amount compulsory",
 * exactly as verifyPayment itself requires to actually verify) — never
 * an unrelated amount from some other transaction, so a customer
 * clicking Refresh on their own checkout page can never see a glimpse
 * of a completely different payment that has nothing to do with their
 * order. Never changes order status, credits a wallet, or marks
 * anything as used — verifyPayment (already called first by the
 * controller before this) is what actually verifies; this only answers
 * "is there something matching sitting there, in case auto-verify
 * hasn't caught up yet".
 */
async function peekLatestTransaction(orderId) {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return null;

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.fampay || !user.fampay.isConnected) return null;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return null;

    const historyResult = await fetchFamPayHistory(user.fampay.email, rawPassword, 5, { sinceMs: typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0 });
    if (!historyResult || !historyResult.status) return null;

    const transactions = historyResult.data || [];
    if (transactions.length === 0) return null;

    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const latest = transactions.find((t) => parseFloat(t.amount) === paymentAmount && isTxnAfterOrder(t, orderCreatedAt));
    if (!latest) return null;
    const txnAmount = parseFloat(latest.amount);

    return {
      amount: txnAmount,
      payerName: (latest.name && latest.name !== 'NA') ? latest.name : null,
    };
  } catch (err) {
    logger.error(`peekLatestTransaction error for ${orderId}: ${err.message}`);
    return null;
  }
}

module.exports = { verifyPayment, checkUtrForOrder, peekLatestTransaction };

},

// ===== routes/subscription.js =====
"routes/subscription.js": function (module, exports, __r) {
// routes/subscription.js
const express = require('express');
const router  = express.Router();
const ctrl    = __r("controllers/subscriptionController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

router.get('/plans',    ctrl.getPlans);                          // public
router.get('/duration-options', ctrl.getDurationOptions);        // public
router.get('/my',       authenticate, blockIfBanned, ctrl.getMySubscription);   // auth
router.post('/auto-upgrade', authenticate, blockIfBanned, ctrl.setAutoUpgrade);  // auth
router.post('/purchase', authenticate, blockIfBanned, paymentLimiter, ctrl.purchasePlan); // auth
router.post('/purchase-wallet', authenticate, blockIfBanned, paymentLimiter, ctrl.purchasePlanWithWallet); // auth

module.exports = router;

},

// ===== controllers/subscriptionController.js =====
"controllers/subscriptionController.js": function (module, exports, __r) {
// controllers/subscriptionController.js
const subscriptionService = __r("services/subscriptionService.js");
const firebaseService     = __r("services/firebaseService.js");
const walletService       = __r("services/walletService.js");
const notificationService = __r("services/notificationService.js");
const zapService          = __r("services/zapService.js");
const { ref }             = __r("firebase/admin.js");
const { DB_PATHS, DEFAULT_PLANS, STAFF_LIMITS_BY_PLAN } = __r("config/constants.js");
const response = __r("helpers/response.js");
const logger   = __r("utils/logger.js");
const { buildCheckoutUrl } = __r("utils/checkoutUrlBuilder.js");
const { body, validationResult } = require('express-validator');

/** GET /api/subscription/plans — public */
// Every plan advertises how many staff accounts it includes (Management → Staff).
const withStaffLimit = (plans) => (plans || []).map((p) => ({
  ...p,
  staffLimit: Number.isFinite(p.staffLimit) ? p.staffLimit : (STAFF_LIMITS_BY_PLAN[p.id] ?? 0),
}));

const getPlans = async (req, res) => {
  try {
    let plans = await subscriptionService.getAllPlans();

    // Fallback: if DB empty, return defaults (happens before first seed)
    if (!plans || plans.length === 0) {
      plans = Object.values(DEFAULT_PLANS).filter(p => p.isActive !== false);
    }

    return response.success(res, 'Plans fetched', { plans: withStaffLimit(plans) });
  } catch (err) {
    // Always return default plans even on error
    const plans = Object.values(DEFAULT_PLANS);
    return response.success(res, 'Plans fetched', { plans: withStaffLimit(plans) });
  }
};

/** GET /api/subscription/duration-options — public. The duration/discount
 * tiers shown on the upgrade flow's "Choose Duration" step. */
const getDurationOptions = async (req, res) => {
  try {
    return response.success(res, 'Duration options fetched', { durations: subscriptionService.getDurationOptions() });
  } catch (err) {
    return response.success(res, 'Duration options fetched', { durations: subscriptionService.getDurationOptions() });
  }
};

/** GET /api/subscription/my */
const setAutoUpgrade = async (req, res) => {
  try {
    const { planId } = req.body; // null/omitted = cancel
    if (planId) {
      const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
      if (!plan) return response.notFound(res, 'Plan not found');
    }
    await subscriptionService.setAutoUpgradePreference(req.user.uid, planId || null);
    return response.success(res, planId ? `Auto-upgrade to this plan enabled.` : 'Auto-upgrade cancelled.', { planId: planId || null });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const getMySubscription = async (req, res) => {
  try {
    const sub = await subscriptionService.getUserSubscription(req.user.uid);
    const [overBalance, autoUpgradeSnap] = await Promise.all([
      walletService.getOverBalance(req.user.uid),
      ref(`${DB_PATHS.USERS}/${req.user.uid}/autoUpgradePlanId`).once('value'),
    ]);
    return response.success(res, 'Subscription fetched', { subscription: sub, overBalance, autoUpgradePlanId: autoUpgradeSnap.val() || null });
  } catch (err) {
    logger.error('Get subscription error:', err.message);
    // Return Blaze as fallback
    return response.success(res, 'Subscription fetched', {
      subscription: {
        planId: 'blaze', status: 'active', endDate: null,
        paymentLinksUsedThisMonth: 0,
        plan: DEFAULT_PLANS.blaze
      },
      overBalance: 0, autoUpgradePlanId: null,
    });
  }
};

/**
 * POST /api/subscription/purchase
 * Creates a payment order for plan upgrade (Zap UPI or Admin Cashier)
 */
const purchasePlan = async (req, res) => {
  try {
    const { planId, confirmDowngrade, durationMonths } = req.body;
    if (!planId) return response.error(res, 'planId required');

    const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
    if (!plan) return response.notFound(res, 'Plan not found');
    if (plan.price === 0) return response.error(res, 'Blaze plan is free — no payment needed');

    // Price is ALWAYS computed here from planId + durationMonths — never
    // trust a client-sent amount, or a tampered request could buy a
    // discount it was never actually offered. Defaults to 1 month (no
    // discount) if omitted, so older frontend builds keep working.
    const pricing = subscriptionService.calculateDurationPrice(plan.price, durationMonths || 1);

    // Weekly Airdrop coupon (optional): applied on top of the duration
    // price above. Validated but NOT marked used here — only once an
    // order/activation actually succeeds below, so a failed payment
    // doesn't burn the coupon.
    if (!pricing) return response.error(res, 'Invalid duration selected');
    let appliedCouponId = null;
    let appliedCouponPercent = null;
    if (req.body.couponId) {
      try {
        const airdropService = __r("services/airdropService.js");
        const { finalAmount, coupon } = await airdropService.previewDiscount(req.user.uid, req.body.couponId, pricing.finalPrice);
        pricing.priceBeforeCoupon = pricing.finalPrice;
        pricing.couponDiscountPercent = coupon.discountPercent;
        pricing.finalPrice = finalAmount;
        appliedCouponId = coupon.id;
        appliedCouponPercent = coupon.discountPercent;
      } catch (couponErr) {
        // A bad/expired/used coupon is a client error, not a server fault.
        return response.error(res, couponErr.message || 'This coupon cannot be used.', 400, { couponInvalid: true });
      }
    }

    const userId = req.user.uid;

    // Guard against silently downgrading (e.g. Developer -> Bronze) without
    // the user explicitly acknowledging they'll lose the higher plan's
    // benefits. The dashboard shows a confirmation modal and resends with
    // confirmDowngrade:true; a direct API call without it gets a clear
    // 409 instead of quietly switching them down.
    const currentSub = await subscriptionService.getUserSubscription(userId);
    const isDowngrade = (plan.displayOrder || 0) < (currentSub?.plan?.displayOrder || 0);
    if (isDowngrade && !confirmDowngrade) {
      return response.error(res, `You're currently on ${currentSub.plan.name}. Switching to ${plan.name} will replace it and you'll lose its higher limits. Confirm to continue.`, 409, { requiresDowngradeConfirmation: true, currentPlan: currentSub.plan.name });
    }

    // Already paid for this plan before (e.g. bought Bronze earlier,
    // upgraded to Developer since, now switching back to Bronze) — skip
    // the UPI payment step entirely and just re-activate it for free.
    const alreadyPaid = await subscriptionService.hasUserPaidForPlan(userId, planId);
    if (alreadyPaid) {
      const sub = await subscriptionService.activateSubscription(userId, planId, 30);
      await walletService.enforceWalletCap(userId, plan.walletLimit);
      await subscriptionService.setAutoUpgradePreference(userId, null);
      await notificationService.createNotification(userId, {
        title: `🎉 ${plan.name} Plan Activated!`,
        message: `Switched back to ${plan.name} — no charge, you already own this plan.`,
        type: 'subscription',
      });
      await firebaseService.logActivity(userId, 'SUBSCRIPTION_REACTIVATED_FREE', { planId: plan.id, planName: plan.name });
      logger.info(`Subscription re-activated (already owned, no charge): ${userId} → ${planId}`);
      return response.success(res, `Switched to ${plan.name} — no charge since you already own this plan.`, { subscription: sub, plan, alreadyOwned: true });
    }

    const orderId = zapService.generateOrderId(userId);

    const settings = await firebaseService.getSettings();
    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) {
        isSystemCashier = true;
      }
    }

    // Save subscription order in payments with type='subscription'.
    // durationMonths/durationDays travel with the record so the webhook
    // (which only ever sees the orderId) knows how many days to activate
    // for once the payment confirms — see zapWebhook.js.
    await firebaseService.createPayment(orderId, {
      userId,
      amount: pricing.finalPrice,
      remark: `ZapPay Subscription - ${plan.name} - ${pricing.months} mo`,
      type: 'subscription',
      planId: plan.id,
      durationMonths: pricing.months,
      durationDays: pricing.durationDays,
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      couponId: appliedCouponId,
      couponDiscountPercent: appliedCouponPercent,
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    if (isSystemCashier) {
        // Same comma-separated FRONTEND_URL caveat as elsewhere — take only the first origin.
        const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
        const dashboardRedir = `${frontendUrl}/index.html?payment=success&order=${orderId}`;
        // Checkout customization (theme, hideIntent, logo, display name) comes
        // from sysAdminUser — the account whose FamPay is actually
        // collecting this payment — not from the customer buying the
        // plan (who has no checkout-theme concept of their own). If the
        // admin has Zenith applied, plan-purchase checkout shows Zenith
        // too, same as any of their own merchant customers would see.
        const checkoutUrl = buildCheckoutUrl(sysAdminUser, { orderId, amount: pricing.finalPrice, upiId: sysAdminUser.fampay.upiId, redirectUrl: dashboardRedir, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });

        logger.info(`Subscription order (System Cashier): ${orderId} user=${userId}`);

        return response.success(res, 'Payment order created', {
            orderId: orderId,
            paymentUrl: checkoutUrl,
            amount: pricing.finalPrice,
            planName: plan.name,
            pricing,
        });
    }

    // Create Zap UPI order
    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(pricing.finalPrice.toFixed(2)),
      remark: `ZapPay ${plan.name} Plan - ${pricing.months} mo`,
    });

    logger.info(`Subscription order: ${orderId} user=${userId} plan=${planId} months=${pricing.months} amount=${pricing.finalPrice}`);
    return response.success(res, 'Payment order created', {
      orderId: zapOrder.orderId,
      paymentUrl: zapOrder.paymentUrl,
      amount: pricing.finalPrice,
      planName: plan.name,
      pricing,
    });
  } catch (err) {
    logger.error('Purchase plan error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/subscription/purchase-wallet
 * Pay for a plan upgrade directly from wallet balance — instant activation,
 * no UPI gateway involved.
 */
const purchasePlanWithWallet = async (req, res) => {
  try {
    const { planId, autoUpgrade, confirmDowngrade, durationMonths } = req.body;
    if (!planId) return response.error(res, 'planId required');

    const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
    if (!plan) return response.notFound(res, 'Plan not found');
    if (plan.price === 0) return response.error(res, 'Blaze plan is free — no payment needed');

    // Same rule as the UPI path: price is always computed here, never
    // trusted from the client.
    const pricing = subscriptionService.calculateDurationPrice(plan.price, durationMonths || 1);

    // Weekly Airdrop coupon (optional): applied on top of the duration
    // price above. Validated but NOT marked used here — only once an
    // order/activation actually succeeds below, so a failed payment
    // doesn't burn the coupon.
    if (!pricing) return response.error(res, 'Invalid duration selected');
    let appliedCouponId = null;
    let appliedCouponPercent = null;
    if (req.body.couponId) {
      try {
        const airdropService = __r("services/airdropService.js");
        const { finalAmount, coupon } = await airdropService.previewDiscount(req.user.uid, req.body.couponId, pricing.finalPrice);
        pricing.priceBeforeCoupon = pricing.finalPrice;
        pricing.couponDiscountPercent = coupon.discountPercent;
        pricing.finalPrice = finalAmount;
        appliedCouponId = coupon.id;
        appliedCouponPercent = coupon.discountPercent;
      } catch (couponErr) {
        // A bad/expired/used coupon is a client error, not a server fault.
        return response.error(res, couponErr.message || 'This coupon cannot be used.', 400, { couponInvalid: true });
      }
    }

    const userId = req.user.uid;

    // Same downgrade guard as the UPI purchase path — see comment there.
    const currentSubForCheck = await subscriptionService.getUserSubscription(userId);
    const isDowngrade = (plan.displayOrder || 0) < (currentSubForCheck?.plan?.displayOrder || 0);
    if (isDowngrade && !confirmDowngrade) {
      return response.error(res, `You're currently on ${currentSubForCheck.plan.name}. Switching to ${plan.name} will replace it and you'll lose its higher limits. Confirm to continue.`, 409, { requiresDowngradeConfirmation: true, currentPlan: currentSubForCheck.plan.name });
    }

    // Already paid for this plan before (e.g. bought Bronze earlier,
    // upgraded to Developer since, now switching back to Bronze) — just
    // re-activate it for free instead of charging a second time. This
    // stays a flat 30-day freebie regardless of the duration picked above
    // — since nothing is actually being charged here, honoring a chosen
    // 24-month discount for free isn't something we want to hand out.
    const alreadyPaid = await subscriptionService.hasUserPaidForPlan(userId, planId);
    if (alreadyPaid) {
      const sub = await subscriptionService.activateSubscription(userId, planId, 30);
      await walletService.enforceWalletCap(userId, plan.walletLimit);
      await subscriptionService.setAutoUpgradePreference(userId, null);
      await notificationService.createNotification(userId, {
        title: `🎉 ${plan.name} Plan Activated!`,
        message: `Switched back to ${plan.name} — no charge, you already own this plan.`,
        type: 'subscription',
      });
      await firebaseService.logActivity(userId, 'SUBSCRIPTION_REACTIVATED_FREE', { planId: plan.id, planName: plan.name });
      logger.info(`Subscription re-activated (already owned, no charge): ${userId} → ${planId}`);
      return response.success(res, `Switched to ${plan.name} — no charge since you already own this plan.`, { subscription: sub, plan, alreadyOwned: true });
    }

    const balance = await walletService.getBalance(userId);

    if (balance < pricing.finalPrice) {
      if (autoUpgrade) {
        // Not enough right now — save this as a standing instruction and
        // silently complete the upgrade the moment enough Zap Cash comes
        // in (see subscriptionService.maybeAutoUpgrade, checked after
        // every wallet credit). That path only ever knows planId (not a
        // duration), so it always auto-upgrades at the plain 1-month
        // price — the multi-month discount picked here doesn't carry
        // over to a deferred auto-upgrade.
        await subscriptionService.setAutoUpgradePreference(userId, planId);
        return response.success(res, `We'll upgrade you to ${plan.name} (1 month) automatically as soon as your Zap Cash covers ₹${plan.price}.`, { autoUpgradeScheduled: true, planId });
      }
      return response.error(res, `Insufficient wallet balance. You need ₹${pricing.finalPrice}, available: ₹${balance.toFixed(2)}`);
    }

    // Debit wallet (transaction-safe, re-checks balance internally)
    try {
      await walletService.debitWallet(userId, pricing.finalPrice, `Subscription: ${plan.name} (${pricing.months} mo)`);
    } catch (debitErr) {
      if (debitErr.message === 'INSUFFICIENT_BALANCE') {
        return response.error(res, 'Insufficient wallet balance.');
      }
      throw debitErr;
    }

    // Activate immediately — no webhook needed for wallet payments
    const sub = await subscriptionService.activateSubscription(userId, planId, pricing.durationDays);
    // Pull back any Over Balance that now fits under the new plan's limit
    await walletService.enforceWalletCap(userId, plan.walletLimit);
    // This purchase supersedes any standing auto-upgrade instruction
    await subscriptionService.setAutoUpgradePreference(userId, null);

    const orderId = zapService.generateOrderId(userId);
    await firebaseService.createPayment(orderId, {
      userId,
      amount: pricing.finalPrice,
      remark: `ZapPay Subscription - Wallet - ${plan.name} - ${pricing.months} mo`,
      type: 'subscription',
      planId: plan.id,
      durationMonths: pricing.months,
      durationDays: pricing.durationDays,
    });
    await firebaseService.updatePaymentStatus(orderId, { status: 'Success', txn_id: 'WALLET', utr: '', amount: pricing.finalPrice, pay_amount: pricing.finalPrice });

    const durationLabel = pricing.months === 1 ? '1 month' : `${pricing.months} months`;
    await notificationService.createNotification(userId, {
      title: `🎉 ${plan.name} Plan Activated!`,
      message: `₹${pricing.finalPrice} deducted from wallet. Your ${plan.name} subscription is now active for ${durationLabel}.`,
      type: 'subscription',
    });

    await firebaseService.logActivity(userId, 'SUBSCRIPTION_ACTIVATED_WALLET', {
      planId: plan.id, planName: plan.name, amount: pricing.finalPrice, durationMonths: pricing.months, orderId,
    });

    logger.info(`Subscription via wallet: ${userId} → ${planId} months=${pricing.months} amount=${pricing.finalPrice}`);
    if (appliedCouponId) await __r("services/airdropService.js").markCouponUsed(userId, appliedCouponId, orderId);

    return response.success(res, `${plan.name} plan activated!`, {
      subscription: sub,
      plan,
      orderId,
      pricing,
    });
  } catch (err) {
    logger.error('Purchase plan with wallet error:', err.message);
    return response.serverError(res, err.message);
  }
};

// ─── Admin Plan Management ──────────────────────────────────

const adminGetPlans = async (req, res) => {
  try {
    let plans = await subscriptionService.getAllPlansAdmin();
    if (!plans || plans.length === 0) plans = Object.values(DEFAULT_PLANS);
    return response.success(res, 'Plans fetched', { plans });
  } catch (err) {
    return response.success(res, 'Plans fetched', { plans: Object.values(DEFAULT_PLANS) });
  }
};

const adminCreatePlan = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { id, name, badge, price, walletLimit, paymentLinksPerMonth,
      linkExpiryDays, commissionPercent, withdrawalCount, withdrawalPeriod,
      features, isHighlighted, displayOrder, webhookLimit, staffLimit } = req.body;

    const existing = await ref(`${DB_PATHS.PLANS}/${id}`).once('value');
    if (existing.exists()) return response.error(res, `Plan ID "${id}" already exists.`);

    const plan = {
      id, name, badge: badge || '',
      price: parseFloat(price),
      walletLimit: parseFloat(walletLimit),
      paymentLinksPerMonth: parseInt(paymentLinksPerMonth),
      linkExpiryDays: parseInt(linkExpiryDays),
      commissionPercent: parseFloat(commissionPercent),
      withdrawalCount: parseInt(withdrawalCount),
      withdrawalPeriod: withdrawalPeriod || 'week',
      webhookLimit: webhookLimit === undefined || webhookLimit === '' ? 1 : parseInt(webhookLimit),
      staffLimit: staffLimit === undefined || staffLimit === '' ? 0 : parseInt(staffLimit),
      features: Array.isArray(features) ? features : [],
      isHighlighted: !!isHighlighted,
      isDefault: false, isActive: true,
      displayOrder: parseInt(displayOrder) || 99,
      createdAt: Date.now(),
    };

    await ref(`${DB_PATHS.PLANS}/${id}`).set(plan);
    return response.success(res, 'Plan created', { plan }, 201);
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminUpdatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await ref(`${DB_PATHS.PLANS}/${id}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Plan not found');

    const allowed = ['name','badge','price','walletLimit','paymentLinksPerMonth',
      'linkExpiryDays','commissionPercent','withdrawalCount','withdrawalPeriod',
      'features','isHighlighted','isActive','displayOrder','webhookLimit','staffLimit'];

    const update = { updatedAt: Date.now() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    // Limits are used in arithmetic elsewhere — never store garbage.
    if (update.webhookLimit !== undefined) {
      update.webhookLimit = parseInt(update.webhookLimit);
      if (!Number.isInteger(update.webhookLimit) || update.webhookLimit < -1) return response.error(res, 'Webhook limit must be -1 (unlimited) or a number from 0.');
    }
    if (update.staffLimit !== undefined) {
      update.staffLimit = parseInt(update.staffLimit);
      if (!Number.isInteger(update.staffLimit) || update.staffLimit < 0 || update.staffLimit > 1000) return response.error(res, 'Staff accounts must be a whole number from 0 to 1000.');
    }
    if (update.features !== undefined && !Array.isArray(update.features)) return response.error(res, 'Features must be a list.');

    await ref(`${DB_PATHS.PLANS}/${id}`).update(update);
    return response.success(res, 'Plan updated');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminDeletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await ref(`${DB_PATHS.PLANS}/${id}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Plan not found');
    if (snap.val().isDefault) return response.error(res, 'Cannot delete the default free plan.');
    await ref(`${DB_PATHS.PLANS}/${id}`).remove();
    return response.success(res, 'Plan deleted');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminAssignPlan = async (req, res) => {
  try {
    const { uid } = req.params;
    const { planId, durationDays } = req.body;

    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
    if (!plan) return response.notFound(res, 'Plan not found');

    const sub = await subscriptionService.activateSubscription(uid, planId, durationDays || 30);

    await notificationService.createNotification(uid, {
      title: '🎉 Plan Activated!',
      message: `Your ${plan.name} plan has been activated! Enjoy your upgraded features.`,
      type: 'subscription',
    });

    return response.success(res, `${plan.name} plan assigned`, { subscription: sub });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminGetPaymentLinks = async (req, res) => {
  try {
    const snap = await ref(DB_PATHS.PAYMENT_LINKS).orderByChild('createdAt').limitToLast(200).once('value');
    const links = [];
    if (snap.exists()) snap.forEach(c => links.push(c.val()));
    return response.success(res, 'Payment links fetched', { links: links.reverse(), total: links.length });
  } catch (err) {
    return response.success(res, 'Payment links fetched', { links: [], total: 0 });
  }
};

const adminGetCommissionLogs = async (req, res) => {
  try {
    // Commission is now earned at withdrawal time (not at payment-receipt
    // time), so withdrawals — not the old commissionLogs table — are the
    // source of truth for commission reporting.
    const withdrawals = await firebaseService.getAllWithdrawals();
    const logs = withdrawals
      .filter((w) => w.commission > 0)
      .map((w) => ({
        userId: w.userId,
        withdrawalId: w.id,
        commission: w.commission,
        netAmount: w.netAmount,
        grossAmount: w.amount,
        status: w.status, // commission is only realized once status === 'approved'
        createdAt: w.createdAt,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const totalCommission = logs
      .filter((l) => l.status === 'approved')
      .reduce((s, l) => s + (l.commission || 0), 0);

    return response.success(res, 'Commission logs fetched', { logs, totalCommission });
  } catch (err) {
    return response.success(res, 'Commission logs fetched', { logs: [], totalCommission: 0 });
  }
};

const planValidation = [
  body('id').notEmpty().matches(/^[a-z0-9_]+$/),
  body('name').notEmpty().isLength({ max: 50 }),
  body('price').isFloat({ min: 0 }),
  body('walletLimit').isFloat({ min: 0 }),
  body('paymentLinksPerMonth').isInt({ min: -1 }),
  body('linkExpiryDays').isInt({ min: -1 }),
  body('commissionPercent').isFloat({ min: 0, max: 100 }),
  body('withdrawalCount').isInt({ min: 1 }),
  body('webhookLimit').optional({ checkFalsy: false, nullable: true }).isInt({ min: -1 }),
  body('staffLimit').optional({ checkFalsy: false, nullable: true }).isInt({ min: 0, max: 1000 }),
];

module.exports = {
  getPlans, getMySubscription, purchasePlan, purchasePlanWithWallet, setAutoUpgrade,
  getDurationOptions,
  adminGetPlans, adminCreatePlan, adminUpdatePlan, adminDeletePlan,
  adminAssignPlan, adminGetPaymentLinks, adminGetCommissionLogs,
  planValidation,
};

},

// ===== services/airdropService.js =====
"services/airdropService.js": function (module, exports, __r) {
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
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");

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

},

// ===== routes/withdrawal.js =====
"routes/withdrawal.js": function (module, exports, __r) {
// routes/withdrawal.js
const express = require('express');
const router = express.Router();
const { requestWithdrawal, getWithdrawalHistory, requestWithdrawalValidation } = __r("controllers/withdrawalController.js");
const { authenticate, blockIfBanned, blockIfImpersonating } = __r("middleware/auth.js");
const { withdrawalLimiter } = __r("middleware/rateLimiter.js");

router.use(authenticate, blockIfBanned);

router.post('/request', blockIfImpersonating, withdrawalLimiter, requestWithdrawalValidation, requestWithdrawal);
router.get('/history', getWithdrawalHistory);

module.exports = router;

},

// ===== controllers/withdrawalController.js =====
"controllers/withdrawalController.js": function (module, exports, __r) {
// controllers/withdrawalController.js - Withdrawal Controller
const { body, validationResult } = require('express-validator');
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const notificationService = __r("services/notificationService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const subscriptionService = __r("services/subscriptionService.js");

const UPI_RE  = /^[\w.-]+@[\w.-]+$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACC_RE  = /^\d{9,18}$/;

/**
 * POST /api/withdrawal/request
 * Submit a withdrawal request. Supports two methods:
 *   method = 'upi'  -> requires upiId, upiHolderName
 *   method = 'bank' -> requires accountNumber, ifscCode, accountHolderName
 * (defaults to 'upi' if not provided, for backward compatibility)
 */
const requestWithdrawal = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return response.error(res, 'Validation failed', 400, errors.array());
    }

    const userId = req.user.uid;
    const method = req.body.method === 'bank' ? 'bank' : 'upi';
    // 'amount' is the NET amount the user wants to actually receive in hand.
    const netAmount = parseFloat(req.body.amount);

    // Per-method field validation. Kept here (rather than as a rigid
    // declarative express-validator chain) since which fields are required
    // depends on the chosen method.
    let upiId = '', upiHolderName = '', accountNumber = '', ifscCode = '', accountHolderName = '';
    if (method === 'upi') {
      upiId = (req.body.upiId || '').trim();
      upiHolderName = (req.body.upiHolderName || '').trim();
      if (!upiId || !UPI_RE.test(upiId)) {
        return response.error(res, 'Please enter a valid UPI ID (e.g. name@bank)');
      }
      if (!upiHolderName) {
        return response.error(res, 'Please enter the UPI holder name');
      }
    } else {
      accountNumber = (req.body.accountNumber || '').replace(/\s+/g, '');
      ifscCode = (req.body.ifscCode || '').trim().toUpperCase();
      accountHolderName = (req.body.accountHolderName || '').trim();
      if (!ACC_RE.test(accountNumber)) {
        return response.error(res, 'Please enter a valid account number (9-18 digits)');
      }
      if (!IFSC_RE.test(ifscCode)) {
        return response.error(res, 'Please enter a valid IFSC code (e.g. HDFC0001234)');
      }
      if (!accountHolderName) {
        return response.error(res, 'Please enter the account holder name');
      }
    }

    // Get platform settings
    const settings = await firebaseService.getSettings();
    const sub = await subscriptionService.getUserSubscription(userId);
    const plan = sub.plan;
    const minWithdrawal = settings.minWithdrawal || 100;
    const commissionPercent = plan.commissionPercent ?? settings.commissionPercent ?? 5;

    if (settings.maintenanceMode) {
      return response.error(res, 'Withdrawal system under maintenance.', 503);
    }

    // Check minimum withdrawal (this is the NET amount the user receives)
    if (netAmount < minWithdrawal) {
      return response.error(res, `Minimum withdrawal amount is ₹${minWithdrawal}`);
    }

    // Commission is added ON TOP of what the user wants — e.g. ₹100 net at
    // 5% commission requires ₹105 held from the wallet (100 + 5).
    const commission     = Math.round((netAmount * commissionPercent) / 100 * 100) / 100;
    const requiredAmount = Math.round((netAmount + commission) * 100) / 100;

    // Check wallet balance against the REQUIRED (gross) amount, not net
    const balance = await walletService.getBalance(userId);
    if (balance < requiredAmount) {
      return response.error(
        res,
        `Insufficient balance. To withdraw ₹${netAmount}, you need ₹${requiredAmount} in your wallet (₹${netAmount} + ${commissionPercent}% commission = ₹${commission}). Available: ₹${balance.toFixed(2)}`
      );
    }

    // Check for pending withdrawal (1 pending at a time)
    const existingWithdrawals = await firebaseService.getUserWithdrawals(userId);
    const hasPending = existingWithdrawals.some((w) => w.status === 'pending');
    if (hasPending) {
      return response.error(res, 'You already have a pending withdrawal request. Please wait for it to be processed.');
    }

    // Hold the REQUIRED (gross) amount from the wallet
    try {
      await walletService.debitWallet(userId, requiredAmount, `Withdrawal request`);
    } catch (debitErr) {
      if (debitErr.message === 'INSUFFICIENT_BALANCE') {
        return response.error(res, 'Insufficient balance');
      }
      throw debitErr;
    }

    // Create withdrawal record — 'amount' = held/gross, 'netAmount' = what user receives
    const withdrawalId = await firebaseService.createWithdrawal(userId, {
      amount: requiredAmount,
      commission,
      netAmount,
      method,
      upiId,
      upiHolderName,
      accountNumber,
      ifscCode,
      accountHolderName,
    });

    const methodLabel = method === 'bank' ? 'Bank Transfer' : 'UPI';
    await notificationService.createNotification(userId, {
      title: '📤 Withdrawal Request Submitted',
      message: `Your ${methodLabel} withdrawal request for ₹${netAmount} (₹${requiredAmount} held incl. ${commissionPercent}% commission) has been submitted and is under review.`,
      type: 'withdrawal',
    });

    await firebaseService.logActivity(userId, 'WITHDRAWAL_REQUEST', {
      withdrawalId,
      amount: requiredAmount,
      netAmount,
      method,
    });

    logger.info(`Withdrawal requested: ${withdrawalId} by ${userId} for ₹${netAmount} via ${method} (held ₹${requiredAmount})`);

    return response.success(res, 'Withdrawal request submitted successfully', {
      withdrawalId,
      amount: requiredAmount,
      commission,
      netAmount,
      method,
      status: 'pending',
    });

  } catch (err) {
    logger.error('Withdrawal request error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/withdrawal/history
 * Get withdrawal history for current user
 */
const getWithdrawalHistory = async (req, res) => {
  try {
    const withdrawals = await firebaseService.getUserWithdrawals(req.user.uid);
    return response.success(res, 'Withdrawal history fetched', { withdrawals });
  } catch (err) {
    logger.error('Get withdrawal history error:', err.message);
    return response.serverError(res, err.message);
  }
};

const requestWithdrawalValidation = [
  body('amount')
    .notEmpty().withMessage('Amount is required')
    .isFloat({ min: 1 }).withMessage('Invalid amount'),
  body('method')
    .optional()
    .isIn(['upi', 'bank']).withMessage('Invalid withdrawal method'),
];

module.exports = {
  requestWithdrawal,
  getWithdrawalHistory,
  requestWithdrawalValidation,
};

},

// ===== routes/notification.js =====
"routes/notification.js": function (module, exports, __r) {
// routes/notification.js
// NOTE: deliberately NOT using blockIfBanned — a banned user still needs to
// see their "Account Suspended" notification (with the reason) here.
const express = require('express');
const router = express.Router();
const { getNotifications, markAsRead, markAllAsRead, getUnreadCount, registerFcmToken, unregisterFcmToken, sendTestPush } = __r("controllers/notificationController.js");
const { authenticate } = __r("middleware/auth.js");

router.use(authenticate);

router.get('/list', getNotifications);
router.get('/count', getUnreadCount);
router.put('/read/:id', markAsRead);
router.put('/read-all', markAllAsRead);
router.post('/fcm-token', registerFcmToken);
router.delete('/fcm-token', unregisterFcmToken);
router.post('/test-push', sendTestPush);

module.exports = router;

},

// ===== controllers/notificationController.js =====
"controllers/notificationController.js": function (module, exports, __r) {
// controllers/notificationController.js - Notification Controller
const notificationService = __r("services/notificationService.js");
const firebaseService = __r("services/firebaseService.js");
const fcmService = __r("services/fcmService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * GET /api/notification/list
 * Get user notifications
 */
const getNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const notifications = await notificationService.getUserNotifications(req.user.uid, limit);
    const unreadCount = notifications.filter((n) => !n.isRead).length;

    return response.success(res, 'Notifications fetched', { notifications, unreadCount });
  } catch (err) {
    logger.error('Get notifications error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/notification/read/:id
 * Mark a notification as read
 */
const markAsRead = async (req, res) => {
  try {
    await notificationService.markAsRead(req.user.uid, req.params.id);
    await firebaseService.logActivity(req.user.uid, 'NOTIFICATION_READ', { notificationId: req.params.id });
    return response.success(res, 'Notification marked as read');
  } catch (err) {
    logger.error('Mark read error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/notification/read-all
 * Mark all notifications as read
 */
const markAllAsRead = async (req, res) => {
  try {
    await notificationService.markAllAsRead(req.user.uid);
    await firebaseService.logActivity(req.user.uid, 'NOTIFICATION_READ_ALL', {});
    return response.success(res, 'All notifications marked as read');
  } catch (err) {
    logger.error('Mark all read error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/notification/count
 * Get unread notification count
 */
const getUnreadCount = async (req, res) => {
  try {
    const count = await notificationService.getUnreadCount(req.user.uid);
    return response.success(res, 'Count fetched', { unreadCount: count });
  } catch (err) {
    return response.success(res, 'Count fetched', { unreadCount: 0 });
  }
};

/**
 * POST /api/notification/fcm-token
 * Body: { token, platform? }
 * Registers (or refreshes) this device's push token for the logged-in
 * user. Called once the browser has granted notification permission and
 * the Firebase SDK has produced a token — see index.html's push-setup.
 */
const registerFcmToken = async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return response.error(res, 'token is required');

    await fcmService.registerToken(req.user.uid, token, {
      platform,
      userAgent: req.headers['user-agent'] || '',
    });

    return response.success(res, 'Push notifications enabled');
  } catch (err) {
    logger.error('Register FCM token error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * DELETE /api/notification/fcm-token
 * Body: { token }
 * Called when the user turns push notifications off on this device.
 */
const unregisterFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return response.error(res, 'token is required');

    await fcmService.unregisterToken(req.user.uid, token);
    return response.success(res, 'Push notifications disabled for this device');
  } catch (err) {
    logger.error('Unregister FCM token error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/notification/test-push
 * Sends a single push straight to the logged-in user's own devices,
 * bypassing payments/webhooks entirely — for isolating whether FCM
 * delivery itself works, separate from anything about Test Mode or
 * payment flows. Check your Vercel function logs right after calling
 * this; fcmService now logs the exact per-device FCM result.
 */
const sendTestPush = async (req, res) => {
  try {
    const result = await fcmService.sendPushToUser(req.user.uid, {
      title: '🔔 Test Push',
      message: 'If you see this as a real notification, push delivery is working.',
      type: 'general',
    });

    if (result.deviceCount === 0) {
      return response.error(res, `No push devices registered for your account (${result.reason}). Try Disable then Enable again.`);
    }
    if (result.ok) {
      return response.success(res, `Sent to ${result.successCount}/${result.deviceCount} device(s). If it still doesn't show up on your phone, that's a delivery/OS-level issue, not a send failure.`, result);
    }
    // Sent, but FCM itself rejected every device — this is the exact
    // error that was previously only visible in Vercel logs.
    const codes = result.errors.map(e => e.code).join(', ');
    return response.error(res, `FCM rejected the push for all ${result.deviceCount} device(s): ${codes}`, 502, result.errors);
  } catch (err) {
    logger.error('Send test push error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  registerFcmToken,
  unregisterFcmToken,
  sendTestPush,
};

},

// ===== routes/referral.js =====
"routes/referral.js": function (module, exports, __r) {
// routes/referral.js
const express = require('express');
const router  = express.Router();
const ctrl    = __r("controllers/referralController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");

router.use(authenticate, blockIfBanned);

router.get('/my', ctrl.getMyReferral);

module.exports = router;

},

// ===== controllers/referralController.js =====
"controllers/referralController.js": function (module, exports, __r) {
// controllers/referralController.js
const referralService = __r("services/referralService.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/** Mask a name like "Rahul Kumar" -> "S***" (matches ZapUPI's display style) */
function maskName(name) {
  if (!name) return '***';
  const parts = name.trim().split(/\s+/);
  return parts.map((p) => p.charAt(0).toUpperCase() + '***').join(' ');
}

/** Mask an email like "name@gmail.com" -> "na***@gmail.com" */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

/** GET /api/referral/my */
const getMyReferral = async (req, res) => {
  try {
    const data = await referralService.getReferralData(req.user.uid);
    data.referrals = data.referrals.map((r) => ({
      ...r,
      name: maskName(r.name),
      email: maskEmail(r.email),
    }));
    const settings = await firebaseService.getSettings();
    data.signupBonus = settings.signupBonus || 0;
    return response.success(res, 'Referral data fetched', data);
  } catch (err) {
    logger.error('Get referral data error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = { getMyReferral };

},

// ===== services/referralService.js =====
"services/referralService.js": function (module, exports, __r) {
// services/referralService.js
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const notificationService = __r("services/notificationService.js");
const logger = __r("utils/logger.js");

/**
 * Get full referral dashboard data for a user: their code, stats, and
 * the list of people they've referred (with status).
 */
async function getReferralData(uid) {
  const user = await firebaseService.getUser(uid);

  const snap = await ref(`${DB_PATHS.REFERRALS}/${uid}`).once('value');
  const referrals = [];
  if (snap.exists()) snap.forEach((child) => referrals.push(child.val()));
  referrals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const totalIncome = referrals.reduce((s, r) => s + (r.commission || 0), 0);

  const now = new Date();
  const thisMonthIncome = referrals
    .filter((r) => {
      if (!r.completedAt) return false;
      const d = new Date(r.completedAt);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, r) => s + (r.commission || 0), 0);

  return {
    referralCode: user?.referralCode || '',
    totalReferrals: referrals.length,
    completedReferrals: referrals.filter((r) => r.status === 'completed').length,
    totalIncome,
    thisMonthIncome,
    referrals,
  };
}

/**
 * Called after a successful WALLET TOP-UP (self-funded "Add Money", not
 * money received via payment links from customers). If this user was
 * referred and this deposit meets the qualifying minimum, and they
 * haven't already triggered a reward, credit the referrer's wallet.
 */
async function processQualifyingDeposit(uid, depositAmount) {
  try {
    const user = await firebaseService.getUser(uid);
    if (!user || !user.referredBy) return;

    const settings = await firebaseService.getSettings();
    const minDeposit = settings.referralQualifyingMinDeposit || 100;
    if (depositAmount < minDeposit) return;

    const refRef = ref(`${DB_PATHS.REFERRALS}/${user.referredBy}/${uid}`);
    const refSnap = await refRef.once('value');
    if (!refSnap.exists()) return;
    const refData = refSnap.val();
    if (refData.status === 'completed') return; // already rewarded — one-time only

    const commPct = refData.commissionPercent || settings.referralCommissionPercent || 25;
    const commission = Math.round(depositAmount * commPct) / 100;

    await walletService.creditWallet(
      user.referredBy,
      commission,
      `Referral commission from ${user.displayName || uid}`
    );

    await refRef.update({
      status: 'completed',
      purchaseAmount: depositAmount,
      commission,
      completedAt: serverTimestamp(),
    });

    await notificationService.createNotification(user.referredBy, {
      title: '🎉 Referral Commission Earned!',
      message: `${user.displayName || 'Your referral'} made a qualifying deposit of ₹${depositAmount}. You earned ₹${commission} (${commPct}%)!`,
      type: 'general',
    });

    logger.info(`Referral reward: ${user.referredBy} +₹${commission} (from ${uid})`);
  } catch (err) {
    logger.error('processQualifyingDeposit error:', err.message);
  }
}

module.exports = { getReferralData, processQualifyingDeposit };

},

// ===== routes/promo.js =====
"routes/promo.js": function (module, exports, __r) {
// routes/promo.js
const express = require('express');
const router  = express.Router();
const ctrl    = __r("controllers/promoController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

router.use(authenticate, blockIfBanned);

router.post('/apply', paymentLimiter, ctrl.applyPromoValidation, ctrl.applyPromo);

module.exports = router;

},

// ===== controllers/promoController.js =====
"controllers/promoController.js": function (module, exports, __r) {
// controllers/promoController.js
const { body, validationResult } = require('express-validator');
const promoService = __r("services/promoService.js");
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/** POST /api/promo/apply */
const applyPromo = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { code } = req.body;
    const result = await promoService.applyPromoCode(req.user.uid, code);

    return response.success(res, `Promo code applied! ₹${result.value} added to your ${result.label}.`, result);
  } catch (err) {
    // These are user-facing validation messages (invalid/expired/used code)
    return response.error(res, err.message || 'Failed to apply promo code');
  }
};

const applyPromoValidation = [
  body('code').notEmpty().withMessage('Promo code is required').isLength({ max: 30 }).trim(),
];

/** GET /api/admin/promo-codes — list all codes */
const adminGetPromoCodes = async (req, res) => {
  try {
    const snap = await ref(DB_PATHS.PROMO_CODES).once('value');
    const codes = [];
    if (snap.exists()) snap.forEach((c) => codes.push(c.val()));
    codes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return response.success(res, 'Promo codes fetched', { codes });
  } catch (err) {
    logger.error('Admin get promo codes error:', err.message);
    return response.serverError(res, err.message);
  }
};

/** POST /api/admin/promo-codes — create a new code */
const adminCreatePromoCode = async (req, res) => {
  try {
    const { code, type, value, maxUses, perUserLimit, description, expiresAt, balanceType } = req.body;
    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode) return response.error(res, 'Code is required');
    if (!value || parseFloat(value) <= 0) return response.error(res, 'Value must be greater than 0');

    const existing = await ref(`${DB_PATHS.PROMO_CODES}/${cleanCode}`).once('value');
    if (existing.exists()) return response.error(res, `Promo code "${cleanCode}" already exists.`);

    await ref(`${DB_PATHS.PROMO_CODES}/${cleanCode}`).set({
      code: cleanCode,
      type: type === 'percent' ? 'percent' : 'fixed',
      balanceType: ['cash', 'credit'].includes(balanceType) ? balanceType : 'bonus',
      value: parseFloat(value),
      maxUses: maxUses === -1 || maxUses === undefined ? -1 : parseInt(maxUses),
      usedCount: 0,
      perUserLimit: parseInt(perUserLimit) || 1,
      isActive: true,
      description: description || '',
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      createdAt: Date.now(),
    });

    return response.success(res, 'Promo code created', { code: cleanCode });
  } catch (err) {
    logger.error('Admin create promo code error:', err.message);
    return response.serverError(res, err.message);
  }
};

/** PUT /api/admin/promo-codes/:code/toggle — enable/disable a code */
const adminTogglePromoCode = async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase();
    const snap = await ref(`${DB_PATHS.PROMO_CODES}/${code}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Promo code not found');
    const newStatus = !snap.val().isActive;
    await ref(`${DB_PATHS.PROMO_CODES}/${code}/isActive`).set(newStatus);
    return response.success(res, `Promo code ${newStatus ? 'activated' : 'deactivated'}`, { isActive: newStatus });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/** PUT /api/admin/promo-codes/:code — edit an existing code's terms */
const adminUpdatePromoCode = async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase();
    const snap = await ref(`${DB_PATHS.PROMO_CODES}/${code}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Promo code not found');

    const { value, maxUses, perUserLimit, description, expiresAt, balanceType } = req.body;
    if (value !== undefined && (!value || parseFloat(value) <= 0)) {
      return response.error(res, 'Value must be greater than 0');
    }

    // Code itself is immutable (it's the DB key) — only terms can change.
    // usedCount/createdAt/isActive are left untouched: usage history and
    // toggle status shouldn't reset just because the terms were edited.
    const updates = {};
    if (value !== undefined) updates.value = parseFloat(value);
    if (maxUses !== undefined) updates.maxUses = (maxUses === -1 || maxUses === '-1') ? -1 : parseInt(maxUses);
    if (perUserLimit !== undefined) updates.perUserLimit = parseInt(perUserLimit) || 1;
    if (description !== undefined) updates.description = description;
    if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt).getTime() : null;
    if (balanceType !== undefined && ['cash', 'credit', 'bonus'].includes(balanceType)) updates.balanceType = balanceType;

    await ref(`${DB_PATHS.PROMO_CODES}/${code}`).update(updates);
    return response.success(res, 'Promo code updated', { code });
  } catch (err) {
    logger.error('Admin update promo code error:', err.message);
    return response.serverError(res, err.message);
  }
};

/** DELETE /api/admin/promo-codes/:code — permanently remove a code */
const adminDeletePromoCode = async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase();
    const snap = await ref(`${DB_PATHS.PROMO_CODES}/${code}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Promo code not found');

    // Deletes the code definition only. Past redemptions already recorded
    // elsewhere (user wallet history, referral logs, etc.) are untouched —
    // this can't claw back credit already granted, it only stops the code
    // from being redeemed again.
    await ref(`${DB_PATHS.PROMO_CODES}/${code}`).remove();
    return response.success(res, 'Promo code deleted');
  } catch (err) {
    logger.error('Admin delete promo code error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  applyPromo, applyPromoValidation,
  adminGetPromoCodes, adminCreatePromoCode, adminTogglePromoCode,
  adminUpdatePromoCode, adminDeletePromoCode,
};

},

// ===== routes/reward.js =====
"routes/reward.js": function (module, exports, __r) {
// routes/reward.js
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/rewardController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");

router.use(authenticate, blockIfBanned);

router.post('/video', ctrl.submitVideo);
router.post('/bug', ctrl.submitBug);
router.get('/mine', ctrl.getMySubmissions);

module.exports = router;

},

// ===== controllers/rewardController.js =====
"controllers/rewardController.js": function (module, exports, __r) {
// controllers/rewardController.js
const rewardService = __r("services/rewardService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

const submitVideo = async (req, res) => {
  try {
    const record = await rewardService.submitVideo(req.user.uid, req.body);
    return response.success(res, 'Video submitted for review', { submission: record });
  } catch (err) {
    return response.error(res, err.message || 'Failed to submit video', 400);
  }
};

const submitBug = async (req, res) => {
  try {
    const record = await rewardService.submitBug(req.user.uid, req.body);
    return response.success(res, 'Bug report submitted for review', { submission: record });
  } catch (err) {
    return response.error(res, err.message || 'Failed to submit bug report', 400);
  }
};

const getMySubmissions = async (req, res) => {
  try {
    const submissions = await rewardService.getUserSubmissions(req.user.uid);
    return response.success(res, 'Submissions fetched', { submissions });
  } catch (err) {
    logger.error('getMySubmissions error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  submitVideo,
  submitBug,
  getMySubmissions,
};

},

// ===== services/rewardService.js =====
"services/rewardService.js": function (module, exports, __r) {
// services/rewardService.js
//
// Backs the "Earn & Rewards" feature's two submission types:
//   - 'video' : a promotional video a merchant made (title + link)
//   - 'bug'   : a bug report (title + description + optional image URLs)
//
// Both share one storage shape and one admin review flow (approve/reject
// with a required comment, plus an optional reward grant on approval).
// This mirrors how withdrawals and KYC-style admin review flows elsewhere
// in this codebase work: a flat collection of submissions, keyed by
// push-id, each carrying its own status and resolution.
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const walletService = __r("services/walletService.js");
const subscriptionService = __r("services/subscriptionService.js");
const notificationService = __r("services/notificationService.js");
const logger = __r("utils/logger.js");

const MAX_BUG_IMAGES = 10;
const MAX_TITLE_LEN = 120;
const MAX_DESCRIPTION_LEN = 3000;
const MAX_LINK_LEN = 500;

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

async function submitVideo(userId, { title, link }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  const cleanLink = String(link || '').trim().slice(0, MAX_LINK_LEN);
  if (!cleanTitle) throw new Error('Video title is required.');
  if (!cleanLink) throw new Error('Video link is required.');
  if (!/^https?:\/\//i.test(cleanLink)) throw new Error('Video link must be a valid URL starting with http(s)://');

  const id = newId('VID');
  const record = {
    id,
    userId,
    type: 'video',
    title: cleanTitle,
    videoLink: cleanLink,
    status: 'pending',
    adminComment: null,
    reward: null,
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedByUid: null,
  };
  await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${id}`).set(record);
  return record;
}

async function submitBug(userId, { title, description, images }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  const cleanDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION_LEN);
  if (!cleanTitle) throw new Error('Bug title is required.');
  if (!cleanDescription) throw new Error('A description of the bug is required.');

  const cleanImages = Array.isArray(images)
    ? images.map((u) => String(u || '').trim()).filter((u) => u && /^https?:\/\//i.test(u)).slice(0, MAX_BUG_IMAGES)
    : [];

  const id = newId('BUG');
  const record = {
    id,
    userId,
    type: 'bug',
    title: cleanTitle,
    description: cleanDescription,
    images: cleanImages,
    status: 'pending',
    adminComment: null,
    reward: null,
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedByUid: null,
  };
  await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${id}`).set(record);
  return record;
}

async function getUserSubmissions(userId) {
  const snap = await ref(DB_PATHS.REWARD_SUBMISSIONS).orderByChild('userId').equalTo(userId).once('value');
  const list = [];
  if (snap.exists()) snap.forEach((c) => list.push(c.val()));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

async function adminListSubmissions({ type, status } = {}) {
  const snap = await ref(DB_PATHS.REWARD_SUBMISSIONS).once('value');
  let list = [];
  if (snap.exists()) snap.forEach((c) => list.push(c.val()));
  if (type) list = list.filter((s) => s.type === type);
  if (status) list = list.filter((s) => s.status === status);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

/**
 * Applies the reward an admin chose when approving a submission. Each
 * reward type reuses an EXISTING mechanism elsewhere in the codebase
 * (wallet credit, plan activation, promo code) rather than inventing a
 * new one, so behavior (notifications, expiry, etc.) stays consistent
 * with how a user would get the same thing any other way.
 */
async function applyReward(userId, reward) {
  if (!reward || !reward.type || reward.type === 'none') return null;

  if (reward.type === 'zap_cash') {
    const amount = parseFloat(reward.amount);
    if (!(amount > 0)) throw new Error('Zap Cash reward amount must be greater than 0.');
    await walletService.creditWallet(userId, amount, 'Earn & Rewards payout');
    return { type: 'zap_cash', amount };
  }

  if (reward.type === 'zap_credit') {
    const amount = parseFloat(reward.amount);
    if (!(amount > 0)) throw new Error('Zap Credit reward amount must be greater than 0.');
    await walletService.creditZapCredit(userId, amount, 'Earn & Rewards payout');
    return { type: 'zap_credit', amount };
  }

  if (reward.type === 'premium_membership') {
    const months = parseInt(reward.months, 10);
    if (!(months >= 1 && months <= 6)) throw new Error('Premium membership reward must be 1–6 months.');
    const planId = reward.planId || 'pro'; // caller should pass a real plan id; 'pro' is a reasonable default if omitted
    const sub = await subscriptionService.activateSubscription(userId, planId, months * 30);
    return { type: 'premium_membership', months, planId, subscription: sub };
  }

  if (reward.type === 'promo_code') {
    const value = parseFloat(reward.amount);
    if (!(value > 0)) throw new Error('Promo code reward value must be greater than 0.');
    const code = `GIFT${newId('')}`.slice(0, 16);
    const balanceType = ['cash', 'credit', 'bonus'].includes(reward.balanceType) ? reward.balanceType : 'bonus';
    await ref(`${DB_PATHS.PROMO_CODES}/${code}`).set({
      code,
      type: 'fixed',
      balanceType,
      value,
      maxUses: 1,
      usedCount: 0,
      perUserLimit: 1,
      isActive: true,
      description: 'Earn & Rewards payout',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days to redeem
      createdAt: Date.now(),
    });
    return { type: 'promo_code', code, value, balanceType };
  }

  throw new Error(`Unknown reward type: ${reward.type}`);
}

/**
 * Approves or rejects a submission. A comment is ALWAYS required (the
 * user explicitly asked for this) — it's the only way the submitter
 * learns why, especially on rejection. Reward is only ever applied on
 * approval, and only once (resolving an already-resolved submission is
 * rejected outright, so a double-click can't double-pay someone).
 */
async function resolveSubmission(submissionId, { status, comment, reward }, adminUid) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('status must be approved or rejected.');
  const cleanComment = String(comment || '').trim();
  if (!cleanComment) throw new Error('A comment is required when approving or rejecting a submission.');

  const snap = await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${submissionId}`).once('value');
  if (!snap.exists()) throw new Error('Submission not found.');
  const submission = snap.val();
  if (submission.status !== 'pending') throw new Error(`This submission was already ${submission.status}.`);

  let appliedReward = null;
  if (status === 'approved' && reward && reward.type && reward.type !== 'none') {
    appliedReward = await applyReward(submission.userId, reward);
  }

  await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${submissionId}`).update({
    status,
    adminComment: cleanComment,
    reward: appliedReward,
    resolvedAt: Date.now(),
    resolvedByUid: adminUid,
  });

  const kindLabel = submission.type === 'video' ? 'promo video' : 'bug report';
  if (status === 'approved') {
    let rewardLine = '';
    if (appliedReward?.type === 'zap_cash') rewardLine = ` You've been credited ₹${appliedReward.amount} Zap Cash.`;
    else if (appliedReward?.type === 'zap_credit') rewardLine = ` You've been credited ₹${appliedReward.amount} Zap Credit.`;
    else if (appliedReward?.type === 'premium_membership') rewardLine = ` You've been granted ${appliedReward.months} month(s) of premium membership.`;
    else if (appliedReward?.type === 'promo_code') rewardLine = ` Here's your reward code: ${appliedReward.code} (worth ₹${appliedReward.value}).`;
    await notificationService.createNotification(submission.userId, {
      title: `🎉 Your ${kindLabel} was approved!`,
      message: `"${submission.title}" has been approved.${rewardLine} Admin note: ${cleanComment}`,
      type: 'general',
    });
  } else {
    await notificationService.createNotification(submission.userId, {
      title: `Your ${kindLabel} submission was reviewed`,
      message: `"${submission.title}" was not approved. Admin note: ${cleanComment}`,
      type: 'general',
    });
  }

  logger.info(`Reward submission ${submissionId} (${submission.type}) resolved as ${status} by admin ${adminUid}`);
  return { ...submission, status, adminComment: cleanComment, reward: appliedReward, resolvedAt: Date.now(), resolvedByUid: adminUid };
}

module.exports = {
  submitVideo,
  submitBug,
  getUserSubmissions,
  adminListSubmissions,
  resolveSubmission,
};

},

// ===== routes/airdrop.js =====
"routes/airdrop.js": function (module, exports, __r) {
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/airdropController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
router.use(authenticate, blockIfBanned);
router.get('/status', ctrl.getStatus);
router.post('/claim', ctrl.claim);
router.get('/coupons', ctrl.listCoupons);
module.exports = router;

},

// ===== controllers/airdropController.js =====
"controllers/airdropController.js": function (module, exports, __r) {
const airdropService = __r("services/airdropService.js");
const response = __r("helpers/response.js");

const getStatus = async (req, res) => {
  try {
    const status = await airdropService.getClaimStatus(req.user.uid);
    return response.success(res, 'Status fetched', status);
  } catch (err) { return response.serverError(res, err.message); }
};

const claim = async (req, res) => {
  try {
    const coupon = await airdropService.claimWeeklyAirdrop(req.user.uid);
    return response.success(res, 'Airdrop claimed!', { coupon });
  } catch (err) {
    return response.error(res, err.message, err.alreadyClaimed ? 409 : 400);
  }
};

const listCoupons = async (req, res) => {
  try {
    const coupons = await airdropService.listMyCoupons(req.user.uid);
    return response.success(res, 'Coupons fetched', { coupons });
  } catch (err) { return response.serverError(res, err.message); }
};

module.exports = { getStatus, claim, listCoupons };

},

// ===== routes/support.js =====
"routes/support.js": function (module, exports, __r) {
// routes/support.js
// IMPORTANT: only `authenticate` here — deliberately NOT `blockIfBanned`.
// A suspended user must still be able to reach support chat.
const express = require('express');
const router = express.Router();
const { getMyMessages, sendMessage, sendMessageValidation } = __r("controllers/supportController.js");
const { authenticate } = __r("middleware/auth.js");

router.get('/messages', authenticate, getMyMessages);
router.post('/messages', authenticate, sendMessageValidation, sendMessage);

module.exports = router;

},

// ===== controllers/supportController.js =====
"controllers/supportController.js": function (module, exports, __r) {
// controllers/supportController.js - User-facing Support Chat
const { body, validationResult } = require('express-validator');
const supportService = __r("services/supportService.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * GET /api/support/messages
 * Fetch the caller's own chat thread with support. Also clears the
 * "unread admin reply" flag, since fetching = the user is looking at it.
 */
const getMyMessages = async (req, res) => {
  try {
    const messages = await supportService.getMessages(req.user.uid);
    await supportService.markReadByUser(req.user.uid);
    return response.success(res, 'Messages fetched', { messages });
  } catch (err) {
    logger.error('Get support messages error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/support/messages
 * Send a message to support. Works even for a banned/suspended account —
 * this is intentionally the one channel a suspended user keeps.
 */
const sendMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const user = await firebaseService.getUser(req.user.uid);
    await supportService.sendUserMessage(
      req.user.uid,
      { displayName: user?.displayName, email: req.user.email },
      req.body.message
    );

    const messages = await supportService.getMessages(req.user.uid);
    return response.success(res, 'Message sent', { messages });
  } catch (err) {
    logger.error('Send support message error:', err.message);
    return response.serverError(res, err.message);
  }
};

const sendMessageValidation = [
  body('message').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }).withMessage('Message too long'),
];

module.exports = { getMyMessages, sendMessage, sendMessageValidation };

},

// ===== services/supportService.js =====
"services/supportService.js": function (module, exports, __r) {
// services/supportService.js - Simple 1:1 Support Chat (user <-> admin)
//
// Schema:
//   supportMessages/{uid}/{pushId} = { id, sender: 'user'|'admin', message, createdAt }
//   supportThreads/{uid}           = { uid, userName, userEmail, lastMessage,
//                                       lastSender, lastMessageAt, createdAt,
//                                       unreadForAdmin, unreadForUser }
//
// Deliberately reachable even when the user is banned (see middleware/auth.js
// blockIfBanned) — this is the one channel a suspended user keeps.

const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");

const MAX_MESSAGE_LENGTH = 1000;

function clean(message) {
  return String(message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * User sends a message. Creates the thread on first contact.
 */
async function sendUserMessage(uid, userMeta, message) {
  const text = clean(message);
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}`).push();
  await msgRef.set({
    id: msgRef.key,
    sender: 'user',
    message: text,
    createdAt: serverTimestamp(),
  });

  const threadRef = ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`);
  const threadSnap = await threadRef.once('value');
  const existing = threadSnap.val() || {};

  await threadRef.update({
    uid,
    userName: userMeta.displayName || userMeta.email || 'User',
    userEmail: userMeta.email || '',
    lastMessage: text,
    lastSender: 'user',
    lastMessageAt: serverTimestamp(),
    unreadForAdmin: (existing.unreadForAdmin || 0) + 1,
    unreadForUser: existing.unreadForUser || 0,
    createdAt: existing.createdAt || serverTimestamp(),
  });

  return msgRef.key;
}

/**
 * Admin replies to a user's thread.
 */
async function sendAdminReply(uid, message) {
  const text = clean(message);
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}`).push();
  await msgRef.set({
    id: msgRef.key,
    sender: 'admin',
    message: text,
    createdAt: serverTimestamp(),
  });

  const threadRef = ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`);
  const threadSnap = await threadRef.once('value');
  const existing = threadSnap.val() || {};

  await threadRef.update({
    lastMessage: text,
    lastSender: 'admin',
    lastMessageAt: serverTimestamp(),
    unreadForUser: (existing.unreadForUser || 0) + 1,
    unreadForAdmin: existing.unreadForAdmin || 0,
  });

  return msgRef.key;
}

/**
 * All messages for one user's thread, oldest first (chat order).
 */
async function getMessages(uid, limit = 300) {
  const snap = await ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}`).once('value');
  if (!snap.exists()) return [];
  const msgs = [];
  snap.forEach((child) => { const v = child.val(); if (v) msgs.push(v); });
  msgs.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
  return msgs.slice(-limit);
}

async function markReadByUser(uid) {
  await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).update({ unreadForUser: 0 }).catch(() => {});
}

async function markReadByAdmin(uid) {
  await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).update({ unreadForAdmin: 0 }).catch(() => {});
}

/**
 * Edit an admin-authored message. Refuses to touch a user's own message —
 * only the sender's own words can be corrected, never the other side's.
 * Also refreshes the thread's lastMessage preview if this was the latest one.
 */
async function editAdminMessage(uid, messageId, newText) {
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}/${messageId}`);
  const snap = await msgRef.once('value');
  if (!snap.exists()) throw new Error('Message not found');
  const msg = snap.val();
  if (msg.sender !== 'admin') throw new Error('Only admin-sent messages can be edited');

  const text = clean(newText);
  await msgRef.update({ message: text, editedAt: serverTimestamp() });

  const threadSnap = await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).once('value');
  const thread = threadSnap.val();
  if (thread && thread.lastSender === 'admin' && thread.lastMessage === msg.message) {
    await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).update({ lastMessage: text });
  }
}

/**
 * Delete an admin-authored message (same one-sided restriction as edit).
 */
async function deleteAdminMessage(uid, messageId) {
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}/${messageId}`);
  const snap = await msgRef.once('value');
  if (!snap.exists()) throw new Error('Message not found');
  if (snap.val().sender !== 'admin') throw new Error('Only admin-sent messages can be deleted');
  await msgRef.remove();
}

/**
 * Admin inbox — every thread, most recently active first.
 */
async function getAllThreads() {
  const snap = await ref(DB_PATHS.SUPPORT_THREADS).once('value');
  if (!snap.exists()) return [];
  const threads = [];
  snap.forEach((child) => { const v = child.val(); if (v) threads.push(v); });
  threads.sort((a, b) => (Number(b?.lastMessageAt) || 0) - (Number(a?.lastMessageAt) || 0));
  return threads;
}

module.exports = {
  sendUserMessage,
  sendAdminReply,
  getMessages,
  markReadByUser,
  markReadByAdmin,
  getAllThreads,
  editAdminMessage,
  deleteAdminMessage,
};

},

// ===== routes/admin.js =====
"routes/admin.js": function (module, exports, __r) {
// routes/admin.js
const express = require('express');
const router = express.Router();
const admin = __r("controllers/adminController.js");
const { authenticate } = __r("middleware/auth.js");
const { requireAdmin } = __r("middleware/adminAuth.js");

// Apply auth + admin check to ALL admin routes
router.use(authenticate, requireAdmin);

router.get('/dashboard', admin.getDashboard);
router.get('/users', admin.getUsers);
router.post('/users/delete-unverified', admin.deleteUnverifiedUsers);
// Alias: some deployed frontend builds call this as DELETE /users-unverified
// (no slash, DELETE method) instead of the original POST /users/delete-unverified.
// Both point to the same handler so whichever shape the live frontend uses works.
router.delete('/users-unverified', admin.deleteUnverifiedUsers);
router.get('/users/:uid', admin.getUserDetail);
router.post('/users/:uid/ban', admin.toggleBan);
router.post('/users/:uid/clear-device', admin.clearUserDevice);
router.post('/users/:uid/reset-login-activity', admin.adminResetLoginActivity);
router.delete('/users/:uid', admin.deleteUser);
router.post('/wallet/adjust', admin.adjustWalletValidation, admin.adjustWallet);
router.get('/payments', admin.getAllPayments);
router.get('/withdrawals', admin.getAllWithdrawals);
router.put('/withdrawals/:id/approve', admin.approveWithdrawal);
router.put('/withdrawals/:id/reject', admin.rejectWithdrawal);
router.get('/settings', admin.getSettings);
router.put('/settings', admin.updateSettings);
router.get('/verification-logs', admin.getVerificationLogs);
router.post('/notifications/send', admin.sendBroadcast);
router.get('/referrals', admin.getAllReferrals);

// ── Management oversight: staff accounts, merchant promo codes, Weekly Airdrop ──
const mgmt = __r("controllers/adminMgmtController.js");
router.get('/staff',                                   mgmt.listStaff);
router.post('/staff/:ownerUid/:staffId/status',        mgmt.setStaffStatus);
router.post('/staff/:ownerUid/:staffId/logout',        mgmt.forceStaffLogout);
router.delete('/staff/:ownerUid/:staffId',             mgmt.removeStaff);
router.get('/merchant-promos',                         mgmt.listMerchantPromos);
router.put('/merchant-promos/:ownerUid/:code/toggle',  mgmt.toggleMerchantPromo);
router.delete('/merchant-promos/:ownerUid/:code',      mgmt.deleteMerchantPromo);
router.get('/airdrop',                                 mgmt.airdropOverview);
router.post('/airdrop/grant',                          mgmt.airdropGrant);
router.post('/airdrop/revoke',                         mgmt.airdropRevoke);

module.exports = router;

// ── Subscription + Plan routes (admin only, already uses authenticate+requireAdmin) ──
const subCtrl = __r("controllers/subscriptionController.js");
const plCtrl  = __r("controllers/paymentLinkController.js");
const promoCtrl = __r("controllers/promoController.js");

router.get('/plans',                    subCtrl.adminGetPlans);
router.post('/plans',                   subCtrl.planValidation, subCtrl.adminCreatePlan);
router.put('/plans/:id',                subCtrl.adminUpdatePlan);
router.delete('/plans/:id',             subCtrl.adminDeletePlan);
router.post('/users/:uid/subscription', subCtrl.adminAssignPlan);
router.get('/payment-links',            subCtrl.adminGetPaymentLinks);
router.get('/commission-logs',          subCtrl.adminGetCommissionLogs);
router.get('/promo-codes',              promoCtrl.adminGetPromoCodes);
router.post('/promo-codes',             promoCtrl.adminCreatePromoCode);
router.put('/promo-codes/:code/toggle', promoCtrl.adminTogglePromoCode);
router.put('/promo-codes/:code',        promoCtrl.adminUpdatePromoCode);
router.delete('/promo-codes/:code',     promoCtrl.adminDeletePromoCode);

// Earn & Rewards — video + bug bounty submission review
router.get('/reward-submissions',          admin.getRewardSubmissions);
router.post('/reward-submissions/:id/resolve', admin.resolveRewardSubmission);

// ── Support chat inbox (admin side) ──
router.get('/support',                  admin.getSupportThreads);
router.get('/support/:uid',             admin.getSupportThreadMessages);
router.post('/support/:uid/reply',      admin.replySupportValidation, admin.replySupportThread);
router.put('/support/:uid/message/:messageId',    admin.editSupportMessageValidation, admin.editSupportMessage);
router.delete('/support/:uid/message/:messageId', admin.deleteSupportMessage);

// ── Controller: per-user activity log + personal notification sender ──
router.get('/users/:uid/activity',      admin.getUserActivity);
router.post('/users/:uid/notify',       admin.sendUserNotificationValidation, admin.sendUserNotification);
router.post('/users/:uid/impersonate',  admin.impersonateUser);

},

// ===== controllers/adminController.js =====
"controllers/adminController.js": function (module, exports, __r) {
// controllers/adminController.js - Admin Panel Controller
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const subscriptionService = __r("services/subscriptionService.js");
const referralService = __r("services/referralService.js");
const notificationService = __r("services/notificationService.js");
const supportService = __r("services/supportService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * GET /api/admin/dashboard
 * Dashboard analytics
 */
const getDashboard = async (req, res) => {
  try {
    const [users, payments, withdrawals, settings] = await Promise.all([
      firebaseService.getAllUsers(),
      firebaseService.getAllPayments(500),
      firebaseService.getAllWithdrawals(),
      firebaseService.getSettings(),
    ]);

    const totalUsers = users.filter((u) => u.role !== 'admin').length;
    // isTest orders are simulated in Test Mode (test.html) — never real
    // money, so they're excluded from every revenue/volume figure below.
    // getAllPayments() below still returns them (with isTest visible per
    // row) for admin support visibility, just not summed into these totals.
    const realPayments = payments.filter((p) => !p.isTest);
    const totalPayments = realPayments.filter((p) => p.status === 'success').length;
    const totalRevenue = realPayments
      .filter((p) => p.status === 'success')
      .reduce((sum, p) => sum + (p.payAmount || p.amount || 0), 0);
    const pendingWithdrawals = withdrawals.filter((w) => w.status === 'pending').length;
    const totalWalletBalance = users.reduce((sum, u) => sum + (u.walletBalance || 0), 0);

    // Last 7 days payments
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentPayments = realPayments.filter(
      (p) => p.status === 'success' && p.createdAt > sevenDaysAgo
    ).length;

    return response.success(res, 'Dashboard data fetched', {
      stats: {
        totalUsers,
        totalPayments,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        pendingWithdrawals,
        totalWalletBalance: Math.round(totalWalletBalance * 100) / 100,
        recentPayments,
      },
      settings,
    });
  } catch (err) {
    logger.error('Dashboard error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/users
 */
const getUsers = async (req, res) => {
  try {
    const users = await firebaseService.getAllUsers();
    return response.success(res, 'Users fetched', { users, total: users.length });
  } catch (err) {
    logger.error('Get users error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/users/:uid
 */
const getUserDetail = async (req, res) => {
  try {
    const { ref } = __r("firebase/admin.js");
    const { DB_PATHS } = __r("config/constants.js");
    const uid = req.params.uid;

    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const [payments, withdrawals, notifications, subscription, referralData, linksSnap] = await Promise.all([
      firebaseService.getUserPayments(uid, 50),
      firebaseService.getUserWithdrawals(uid),
      notificationService.getUserNotifications(uid, 200),
      subscriptionService.getUserSubscription(uid).catch(() => null),
      referralService.getReferralData(uid).catch(() => null),
      ref(DB_PATHS.PAYMENT_LINKS).orderByChild('userId').equalTo(uid).once('value'),
    ]);

    const links = [];
    if (linksSnap.exists()) linksSnap.forEach((child) => links.push(child.val()));

    const realPayments = payments.filter((p) => !p.isTest);
    const successfulPayments = realPayments.filter((p) => p.status === 'success');
    const stats = {
      payments: {
        total: realPayments.length,
        successful: successfulPayments.length,
        totalReceived: successfulPayments.reduce((s, p) => s + (p.amount || 0), 0),
        testOrders: payments.filter((p) => p.isTest).length,
      },
      withdrawals: {
        total: withdrawals.length,
        approved: withdrawals.filter((w) => w.status === 'approved').length,
        pending: withdrawals.filter((w) => w.status === 'pending').length,
        totalWithdrawn: withdrawals.filter((w) => w.status === 'approved').reduce((s, w) => s + (w.amount || 0), 0),
      },
      notifications: {
        total: notifications.length,
        unread: notifications.filter((n) => !n.isRead).length,
      },
      paymentLinks: {
        total: links.length,
        active: links.filter((l) => l.status === 'active').length,
      },
      referrals: {
        total: referralData?.totalReferrals || 0,
        completed: (referralData?.referrals || []).filter((r) => r.status === 'completed').length,
      },
      plan: subscription?.plan?.name || 'Blaze',
      planExpiresAt: subscription?.endDate || null,
    };

    return response.success(res, 'User detail fetched', { user, payments, withdrawals, stats });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/ban
 * body: { reason } — only used/stored when the action is a ban (not an unban)
 */
const toggleBan = async (req, res) => {
  try {
    const { uid } = req.params;
    const { reason } = req.body;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const newBanStatus = !user.isBanned;
    await firebaseService.setBanStatus(uid, newBanStatus, reason);

    const action = newBanStatus ? 'banned' : 'unbanned';
    logger.info(`User ${uid} ${action} by admin ${req.user.uid}`);

    // Notify the user — this also lands in their Notifications list (kept
    // reachable for banned users; see routes/notification.js) so the ban
    // reason is visible there too, not just on the suspended screen.
    const cleanReason = (reason || '').trim();
    await notificationService.createNotification(uid, newBanStatus ? {
      type: 'security',
      title: 'Account Suspended',
      message: cleanReason || 'Your account has been suspended for violating our Terms of Service.',
    } : {
      type: 'security',
      title: 'Account Reinstated',
      message: 'Your account has been reviewed and reinstated. You now have full access again.',
    }).catch((e) => logger.error('Ban notification failed:', e.message));

    // Two log entries on purpose: one under the admin (accountability —
    // "who banned whom"), one under the target (so it actually shows up
    // when Controller → Activity Log is opened for THIS user).
    await firebaseService.logActivity(req.user.uid, `USER_${action.toUpperCase()}`, { targetUid: uid, reason: newBanStatus ? cleanReason : '' });
    await firebaseService.logActivity(uid, `USER_${action.toUpperCase()}`, { byAdmin: req.user.uid, reason: newBanStatus ? cleanReason : '' });

    return response.success(res, `User ${action} successfully`, { isBanned: newBanStatus, banReason: newBanStatus ? (reason || '').trim() : '' });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/clear-device
 * Frees a merchant's single-device login slot — needed when a user loses
 * access to their old device (lost/stolen/reset phone, cleared browser
 * data, etc.) and can no longer log out from it themselves.
 */
const clearUserDevice = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    await firebaseService.clearActiveDevice(uid);
    await firebaseService.logActivity(req.user.uid, 'DEVICE_LOCK_CLEARED', { targetUid: uid });

    return response.success(res, 'Device lock cleared. User can now log in from a new device.');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/delete-unverified
 * Bulk-deletes accounts with no name, no email, AND no wallet balance in
 * one shot. Any account with at least one of those three is untouched.
 */
const deleteUnverifiedUsers = async (req, res) => {
  try {
    const deletedUids = await firebaseService.deleteUnverifiedUsers();
    logger.info(`${deletedUids.length} unverified users deleted by admin ${req.user.uid}`);
    if (deletedUids.length > 0) {
      await firebaseService.logActivity(req.user.uid, 'BULK_DELETE_UNVERIFIED', { count: deletedUids.length });
    }
    return response.success(res, `${deletedUids.length} unverified user(s) deleted`, { deletedCount: deletedUids.length, deletedUids });
  } catch (err) {
    logger.error('Delete unverified users error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * DELETE /api/admin/users/:uid
 * Permanently removes a user's profile from the database.
 */
const deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');
    if (user.role === 'admin') return response.error(res, 'Cannot delete an admin account.');

    const balance = user.wallet?.balance || 0;
    if (balance > 0 && req.query.force !== 'true') {
      return response.error(res, `This user still has ₹${balance} in their wallet. Confirm again to delete anyway.`);
    }

    await firebaseService.deleteUser(uid);
    logger.info(`User ${uid} deleted by admin ${req.user.uid}`);
    await firebaseService.logActivity(req.user.uid, 'USER_DELETED', { targetUid: uid, walletBalanceAtDeletion: balance });

    return response.success(res, 'User deleted successfully');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/wallet/adjust
 * Manual wallet credit or debit
 */
const adjustWallet = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { userId, amount, reason } = req.body;
    const walletType = ['bonus', 'credit'].includes(req.body.walletType) ? req.body.walletType : 'cash';
    const adjustAmount = parseFloat(amount);

    const user = await firebaseService.getUser(userId);
    if (!user) return response.notFound(res, 'User not found');

    let newBalance;
    if (walletType === 'bonus') newBalance = await walletService.adminAdjustBonusWallet(userId, adjustAmount, reason || 'Admin adjustment');
    else if (walletType === 'credit') newBalance = await walletService.adminAdjustZapCredit(userId, adjustAmount, reason || 'Admin adjustment');
    else newBalance = await walletService.adminAdjustWallet(userId, adjustAmount, reason || 'Admin adjustment');
    if (walletType === 'cash' && adjustAmount > 0) {
      try { await subscriptionService.maybeAutoUpgrade(userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }
    }

    const label = walletType === 'bonus' ? 'Zap Bonus' : walletType === 'credit' ? 'Zap Credit' : 'Zap Cash';
    await notificationService.createNotification(userId, {
      title: adjustAmount > 0 ? `💰 ${label} Credited` : `💸 ${label} Debited`,
      message: `${adjustAmount > 0 ? '₹' + adjustAmount + ' added to' : '₹' + Math.abs(adjustAmount) + ' deducted from'} your ${label} by admin. Reason: ${reason || 'N/A'}`,
      type: 'general',
    });

    await firebaseService.logActivity(req.user.uid, 'ADMIN_WALLET_ADJUST', {
      targetUid: userId,
      walletType,
      amount: adjustAmount,
      reason: reason || '',
    });
    await firebaseService.logActivity(userId, 'ADMIN_WALLET_ADJUST', {
      byAdmin: req.user.uid,
      walletType,
      amount: adjustAmount,
      reason: reason || '',
    });

    return response.success(res, `${label} adjusted`, { newBalance, walletType });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE' || err.message === 'INSUFFICIENT_BONUS_BALANCE' || err.message === 'INSUFFICIENT_ZAP_CREDIT') {
      return response.error(res, 'User has insufficient balance for debit');
    }
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/payments
 */
const getAllPayments = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const payments = await firebaseService.getAllPayments(limit);
    return response.success(res, 'Payments fetched', { payments, total: payments.length });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/withdrawals
 */
const getAllWithdrawals = async (req, res) => {
  try {
    const withdrawals = await firebaseService.getAllWithdrawals();
    return response.success(res, 'Withdrawals fetched', { withdrawals });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/admin/withdrawals/:id/approve
 */
const approveWithdrawal = async (req, res) => {
  try {
    const withdrawal = await firebaseService.getWithdrawal(req.params.id);
    if (!withdrawal) return response.notFound(res, 'Withdrawal not found');
    if (withdrawal.status !== 'pending') {
      return response.error(res, `Withdrawal is already ${withdrawal.status}`);
    }

    await firebaseService.updateWithdrawalStatus(req.params.id, 'approved', req.body.note || '');

    await notificationService.notifyWithdrawalStatus(withdrawal.userId, withdrawal.netAmount, 'approved');

    await firebaseService.logActivity(req.user.uid, 'WITHDRAWAL_APPROVED', {
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      amount: withdrawal.amount,
    });
    await firebaseService.logActivity(withdrawal.userId, 'WITHDRAWAL_APPROVED', {
      withdrawalId: req.params.id,
      byAdmin: req.user.uid,
      amount: withdrawal.amount,
    });

    return response.success(res, 'Withdrawal approved successfully');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/admin/withdrawals/:id/reject
 */
const rejectWithdrawal = async (req, res) => {
  try {
    const withdrawal = await firebaseService.getWithdrawal(req.params.id);
    if (!withdrawal) return response.notFound(res, 'Withdrawal not found');
    if (withdrawal.status !== 'pending') {
      return response.error(res, `Withdrawal is already ${withdrawal.status}`);
    }

    const note = req.body.note || 'Request rejected by admin';

    await firebaseService.updateWithdrawalStatus(req.params.id, 'rejected', note);

    // Refund wallet on rejection
    await walletService.creditWallet(withdrawal.userId, withdrawal.amount, 'Withdrawal refund');

    await notificationService.notifyWithdrawalStatus(withdrawal.userId, withdrawal.amount, 'rejected', note);

    await firebaseService.logActivity(req.user.uid, 'WITHDRAWAL_REJECTED', {
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      reason: note,
    });
    await firebaseService.logActivity(withdrawal.userId, 'WITHDRAWAL_REJECTED', {
      withdrawalId: req.params.id,
      byAdmin: req.user.uid,
      reason: note,
    });

    return response.success(res, 'Withdrawal rejected and amount refunded');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/settings
 */
const getSettings = async (req, res) => {
  try {
    const settings = await firebaseService.getSettings();
    const { ref } = __r("firebase/admin.js");
    const { DB_PATHS } = __r("config/constants.js");
    const adminsSnap = await ref(DB_PATHS.USERS).orderByChild('role').equalTo('admin').once('value');
    const adminCashiers = [];
    if (adminsSnap.exists()) {
        adminsSnap.forEach(child => {
            const u = child.val();
            if (u.fampay && u.fampay.isConnected) {
                adminCashiers.push({ uid: u.uid, name: u.displayName || u.email, upiId: u.fampay.upiId, checkoutTheme: u.checkoutTheme || 'zenith' });
            }
        });
    }
    return response.success(res, 'Settings fetched', { settings, adminCashiers });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/verification-logs
 * Read-only feed of recent payment-verification decisions (auto or
 * manual). Deliberately never includes the merchant's connected mailbox
 * address, IMAP credentials, or raw email content — see
 * firebaseService.logVerificationAttempt() / fampayService.js for what
 * is and isn't written into a log entry in the first place. Optional
 * ?orderId= filters to one order's history; otherwise returns the most
 * recent entries across all orders.
 */
const getVerificationLogs = async (req, res) => {
  try {
    const { orderId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const logs = await firebaseService.getVerificationLogs({ orderId, limit });
    return response.success(res, 'Verification logs fetched', { logs });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/admin/settings
 */
const updateSettings = async (req, res) => {
  try {
    const allowed = [
      'minWithdrawal', 'commissionPercent', 'maintenanceMode', 'siteName', 'supportEmail',
      'signupBonus', 'referralCommissionPercent', 'referralQualifyingMinDeposit', 'signupZapCredit', 'socialLinks',
      'systemRoutingMode', 'systemRoutingAdminUid', 'hideWalletSystemEnabled', 'minZapCreditPurchase', 'fampayInviteLink', 'imgbbApiKey',
      'amountTimeVerificationMode',
      // Agentic Support — see config/constants.js's DEFAULT_SETTINGS comment
      // for what each of these does.
      'agenticSupportEnabled', 'zppXPrimaryModel', 'zppXFallbackModel', 'zppYPrimaryModel', 'zppYFallbackModel',
    ];
    const update = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    });

    await firebaseService.updateSettings(update);
    await firebaseService.logActivity(req.user.uid, 'SETTINGS_UPDATED', update);

    return response.success(res, 'Settings updated');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/notifications/send
 * Broadcast notification to all users
 */
const sendBroadcast = async (req, res) => {
  try {
    const { title, message, type } = req.body;
    if (!title || !message) return response.error(res, 'Title and message required');

    const count = await notificationService.broadcastNotification({ title, message, type });

    return response.success(res, `Notification sent to ${count} users`);
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/referrals
 * All referral relationships across the platform, for oversight
 */
const getAllReferrals = async (req, res) => {
  try {
    const { ref } = __r("firebase/admin.js");
    const { DB_PATHS } = __r("config/constants.js");
    const snap = await ref(DB_PATHS.REFERRALS).once('value');
    const referrals = [];
    if (snap.exists()) {
      snap.forEach((referrerSnap) => {
        referrerSnap.forEach((r) => referrals.push(r.val()));
      });
    }
    referrals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const totalCommissionPaid = referrals.reduce((s, r) => s + (r.commission || 0), 0);
    return response.success(res, 'Referrals fetched', {
      referrals,
      total: referrals.length,
      completed: referrals.filter((r) => r.status === 'completed').length,
      totalCommissionPaid,
    });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adjustWalletValidation = [
  body('userId').notEmpty().withMessage('User ID required'),
  body('amount').isFloat({ min: -100000, max: 100000 }).withMessage('Invalid amount'),
  body('reason').optional().isLength({ max: 200 }).trim().escape(),
  body('walletType').optional().isIn(['cash', 'bonus', 'credit']).withMessage('Invalid wallet type'),
];

/**
 * GET /api/admin/support
 * Inbox — every user's support thread, most recently active first.
 */
const getSupportThreads = async (req, res) => {
  try {
    const threads = await supportService.getAllThreads();
    return response.success(res, 'Support threads fetched', { threads });
  } catch (err) {
    logger.error('Get support threads error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/support/:uid
 * One user's full conversation. Marks it read for admin.
 */
const getSupportThreadMessages = async (req, res) => {
  try {
    const { uid } = req.params;
    const [messages, user] = await Promise.all([
      supportService.getMessages(uid),
      firebaseService.getUser(uid),
    ]);
    await supportService.markReadByAdmin(uid);
    return response.success(res, 'Messages fetched', {
      messages,
      user: user ? { uid: user.uid, displayName: user.displayName, email: user.email, isBanned: !!user.isBanned, banReason: user.banReason || '' } : null,
    });
  } catch (err) {
    logger.error('Get support thread error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/support/:uid/reply
 */
const replySupportThread = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    await supportService.sendAdminReply(uid, req.body.message);
    const messages = await supportService.getMessages(uid);
    return response.success(res, 'Reply sent', { messages });
  } catch (err) {
    logger.error('Reply support thread error:', err.message);
    return response.serverError(res, err.message);
  }
};

const replySupportValidation = [
  body('message').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }).withMessage('Message too long'),
];

/**
 * PUT /api/admin/support/:uid/message/:messageId
 */
const editSupportMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());
    const { uid, messageId } = req.params;
    await supportService.editAdminMessage(uid, messageId, req.body.message);
    const messages = await supportService.getMessages(uid);
    return response.success(res, 'Message updated', { messages });
  } catch (err) {
    return response.error(res, err.message || 'Failed to edit message');
  }
};

/**
 * DELETE /api/admin/support/:uid/message/:messageId
 */
const deleteSupportMessage = async (req, res) => {
  try {
    const { uid, messageId } = req.params;
    await supportService.deleteAdminMessage(uid, messageId);
    const messages = await supportService.getMessages(uid);
    return response.success(res, 'Message deleted', { messages });
  } catch (err) {
    return response.error(res, err.message || 'Failed to delete message');
  }
};

const editSupportMessageValidation = [
  body('message').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }).withMessage('Message too long'),
];

/**
 * GET /api/admin/users/:uid/activity
 * Full activity timeline for the Controller → Activity Log view.
 */
const getUserActivity = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');
    const logs = await firebaseService.getUserActivityLog(uid);
    return response.success(res, 'Activity fetched', {
      logs,
      user: { uid: user.uid, displayName: user.displayName, email: user.email },
    });
  } catch (err) {
    logger.error('Get user activity error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/notify
 * Send a one-off "Notice" to a single user — Controller → Notification.
 * Always type 'admin_notice' — this is what tells the user panel to show
 * it as a one-time popup (not just a bell-icon list item), see index.html.
 */
const sendUserNotification = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const { title, message } = req.body;
    await notificationService.createNotification(uid, {
      title: title.trim(),
      message: message.trim(),
      type: 'admin_notice',
    });

    await firebaseService.logActivity(req.user.uid, 'ADMIN_NOTIFICATION_SENT', { targetUid: uid, title: title.trim() });
    await firebaseService.logActivity(uid, 'ADMIN_NOTIFICATION_SENT', { byAdmin: req.user.uid, title: title.trim() });

    return response.success(res, 'Notice sent');
  } catch (err) {
    logger.error('Send user notification error:', err.message);
    return response.serverError(res, err.message);
  }
};

const sendUserNotificationValidation = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 100 }),
  body('message').trim().notEmpty().withMessage('Message is required').isLength({ max: 500 }),
];

/**
 * POST /api/admin/users/:uid/impersonate
 * "Login as User" — issues a short-lived (1h) token for the target user's
 * own account, so admin can view their dashboard/activity exactly as they
 * see it. Money-moving actions (withdrawal requests, payout-detail edits)
 * stay blocked on this token via blockIfImpersonating — investigation only.
 * Heavily logged both ends, precisely so a later fraud dispute has a clear,
 * timestamped record of who looked at what and when.
 */
const impersonateUser = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const token = jwt.sign(
      { uid, email: user.email, role: user.role || 'user', impersonatedBy: req.user.uid },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    await firebaseService.logActivity(req.user.uid, 'ADMIN_IMPERSONATION_STARTED', { targetUid: uid, targetEmail: user.email || '' });
    await firebaseService.logActivity(uid, 'ADMIN_IMPERSONATION_STARTED', { byAdmin: req.user.uid });
    logger.info(`Admin ${req.user.uid} started impersonating user ${uid}`);

    return response.success(res, 'Impersonation token issued', {
      token,
      user: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: user.role,
        walletBalance: user.wallet?.balance || 0,
        isBanned: !!user.isBanned,
        banReason: user.banReason || '',
        isNewUser: false,
      },
    });
  } catch (err) {
    logger.error('Impersonate user error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/reset-login-activity
 * Force-invalidates every outstanding login session for this account by
 * bumping tokenVersion — any JWT issued before this call stops verifying
 * on the very next request (see middleware/auth.js), so the account comes
 * back completely fresh: every device that was logged in gets kicked out
 * and has to sign in again. This is now the tool for "something's wrong
 * with this account's sessions, start clean" — replacing the old
 * single-device lock, which this same reset used to just clear.
 * Does not touch the account itself (wallet, plan, bans, etc.) — only
 * session state.
 */
const adminResetLoginActivity = async (req, res) => {
  try {
    const { ref } = __r("firebase/admin.js");
    const { DB_PATHS } = __r("config/constants.js");
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const nextVersion = (user.tokenVersion || 0) + 1;
    await ref(`${DB_PATHS.USERS}/${uid}`).update({
      tokenVersion: nextVersion,
      activeDevice: null, // clear any stale slot left over from the old single-device system
    });

    await firebaseService.logActivity(req.user.uid, 'ADMIN_RESET_LOGIN_ACTIVITY', { targetUid: uid, targetEmail: user.email || '' });
    logger.info(`Admin ${req.user.uid} reset login activity for user ${uid}`);

    return response.success(res, 'Login activity reset — this account is signed out everywhere and can log in fresh on any device.');
  } catch (err) {
    logger.error('Reset login activity error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * "Earn & Rewards" admin review — one list endpoint shared by both
 * submission types (video, bug), filterable by type and/or status so
 * the panel can show "Pending videos" / "Pending bugs" tabs from the
 * same list call.
 */
const getRewardSubmissions = async (req, res) => {
  try {
    const rewardService = __r("services/rewardService.js");
    const { type, status } = req.query;
    const submissions = await rewardService.adminListSubmissions({ type, status });

    // Submitter's name/email is genuinely useful context for a reviewer
    // and isn't stored on the submission itself — attach it here rather
    // than making rewardService reach into user records (keeps that
    // service free of any admin-only concerns).
    const uids = [...new Set(submissions.map((s) => s.userId))];
    const users = await Promise.all(uids.map((uid) => firebaseService.getUser(uid).catch(() => null)));
    const userMap = {};
    uids.forEach((uid, i) => { userMap[uid] = users[i]; });

    const enriched = submissions.map((s) => ({
      ...s,
      submitterName: userMap[s.userId]?.name || userMap[s.userId]?.email || s.userId,
      submitterEmail: userMap[s.userId]?.email || '',
    }));

    return response.success(res, 'Submissions fetched', { submissions: enriched });
  } catch (err) {
    logger.error('getRewardSubmissions error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * Approve/reject a video or bug submission, with a required comment and
 * an optional reward grant (only applied on approval — see
 * rewardService.applyReward for what each reward type does).
 */
const resolveRewardSubmission = async (req, res) => {
  try {
    const rewardService = __r("services/rewardService.js");
    const { id } = req.params;
    const { status, comment, reward } = req.body;

    const result = await rewardService.resolveSubmission(id, { status, comment, reward }, req.user.uid);

    await firebaseService.logActivity(req.user.uid, 'REWARD_SUBMISSION_RESOLVED', {
      submissionId: id, type: result.type, status, rewardType: reward?.type || 'none',
    });

    return response.success(res, `Submission ${status}`, { submission: result });
  } catch (err) {
    logger.error('resolveRewardSubmission error:', err.message);
    return response.error(res, err.message || 'Failed to resolve submission', 400);
  }
};

module.exports = {
  getDashboard,
  getUsers,
  getUserDetail,
  toggleBan,
  clearUserDevice,
  adminResetLoginActivity,
  deleteUser,
  deleteUnverifiedUsers,
  adjustWallet,
  adjustWalletValidation,
  getAllPayments,
  getAllWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  getSettings,
  updateSettings,
  getVerificationLogs,
  sendBroadcast,
  getAllReferrals,
  getSupportThreads,
  getSupportThreadMessages,
  replySupportThread,
  replySupportValidation,
  editSupportMessage,
  deleteSupportMessage,
  editSupportMessageValidation,
  getUserActivity,
  sendUserNotification,
  sendUserNotificationValidation,
  impersonateUser,
  getRewardSubmissions,
  resolveRewardSubmission,
};

},

// ===== middleware/adminAuth.js =====
"middleware/adminAuth.js": function (module, exports, __r) {
// middleware/adminAuth.js - Admin Role Check Middleware
const { ref } = __r("firebase/admin.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * Check if authenticated user has admin role
 * Must be used AFTER authenticate middleware
 */
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return response.unauthorized(res);
    }

    // Fetch fresh role from DB to prevent stale JWT role
    const userSnap = await ref(`users/${req.user.uid}`).once('value');
    if (!userSnap.exists()) {
      return response.unauthorized(res, 'User not found');
    }

    const user = userSnap.val();

    if (user.role !== 'admin') {
      return response.forbidden(res, 'Admin access required');
    }

    // Update req.user with fresh data
    req.user.role = 'admin';
    req.adminUser = user;

    next();
  } catch (err) {
    logger.error('Admin auth middleware error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = { requireAdmin };

},

// ===== controllers/adminMgmtController.js =====
"controllers/adminMgmtController.js": function (module, exports, __r) {
// controllers/adminMgmtController.js
// Admin-side oversight of the Management features: staff accounts,
// merchant promo codes and the Weekly Airdrop.
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const firebaseService = __r("services/firebaseService.js");
const staffService = __r("services/staffService.js");
const airdropService = __r("services/airdropService.js");
const notificationService = __r("services/notificationService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

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

},

// ===== services/staffService.js =====
"services/staffService.js": function (module, exports, __r) {
// services/staffService.js
// Staff accounts a merchant creates under their own account.
//
//   staff/{ownerUid}/{staffId}  → the staff record (password is a scrypt hash)
//   staffIndex/{username}       → { ownerUid, staffId }  (login lookup + unique usernames)
//
// A staff login gets a JWT whose `uid` is the OWNER's uid (so every existing
// data query just works) plus a `staffId` claim. middleware/auth.js then
// restricts what that token may call (config/staffPermissions.js).
const crypto = require('crypto');
const { promisify } = require('util');
const { ref } = __r("firebase/admin.js");
const { DB_PATHS, STAFF_LIMITS_BY_PLAN } = __r("config/constants.js");
const { PERMISSION_KEYS } = __r("config/staffPermissions.js");
const subscriptionService = __r("services/subscriptionService.js");
const logger = __r("utils/logger.js");

const scrypt = promisify(crypto.scrypt);

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{3,23}$/;

class StaffError extends Error {
  constructor(message, status = 400, extra = null) {
    super(message);
    this.name = 'StaffError';
    this.status = status;
    this.extra = extra;
  }
}

/* ───────────── password hashing (built-in scrypt, no extra dependency) ───────────── */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored || '').split(':');
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch (e) {
    return false;
  }
}

/* ───────────── validation ───────────── */
function cleanText(value, { label, min = 0, max, required = false }) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (required && !v) throw new StaffError(`${label} is required.`);
  if (v && v.length < min) throw new StaffError(`${label} must be at least ${min} characters.`);
  if (v.length > max) throw new StaffError(`${label} must be at most ${max} characters.`);
  return v;
}

function cleanUsername(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!USERNAME_RE.test(v)) {
    throw new StaffError('Username must be 4–24 characters and use only letters, numbers, dot, dash or underscore.');
  }
  return v;
}

function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8) throw new StaffError('Password must be at least 8 characters.');
  if (p.length > 64) throw new StaffError('Password must be at most 64 characters.');
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) throw new StaffError('Password must contain at least one letter and one number.');
  return p;
}

function cleanPermissions(value) {
  if (!Array.isArray(value)) throw new StaffError('Choose at least one permission for this staff member.');
  const unique = [...new Set(value.map(String))];
  const unknown = unique.filter((k) => !PERMISSION_KEYS.includes(k));
  if (unknown.length) throw new StaffError(`Unknown permission: ${unknown[0]}`);
  if (!unique.length) throw new StaffError('Choose at least one permission for this staff member.');
  return unique;
}

/* ───────────── plan limit ───────────── */
async function getLimitInfo(ownerUid) {
  const sub = await subscriptionService.getUserSubscription(ownerUid);
  const plan = (sub && sub.plan) || {};
  const planId = (sub && sub.planId) || plan.id || 'blaze';
  const limit = Number.isFinite(plan.staffLimit) ? plan.staffLimit : (STAFF_LIMITS_BY_PLAN[planId] ?? 0);
  return { planId, planName: plan.name || planId, limit: Math.max(0, limit) };
}

/* ───────────── helpers ───────────── */
function publicView(s) {
  return {
    id: s.id,
    name: s.name,
    username: s.username,
    role: s.role || '',
    duties: s.duties || '',
    permissions: s.permissions || [],
    isActive: !!s.isActive,
    suspendedByPlan: !!s.suspendedByPlan,
    createdAt: s.createdAt || null,
    updatedAt: s.updatedAt || null,
    lastLoginAt: s.lastLoginAt || null,
  };
}

async function loadAll(ownerUid) {
  const snap = await ref(`${DB_PATHS.STAFF}/${ownerUid}`).once('value');
  const val = snap.exists() ? snap.val() : {};
  return Object.values(val).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * If the owner's plan shrank (downgrade / expiry), the OLDEST accounts up to
 * the new limit stay usable and the rest are suspended until the owner
 * upgrades or deletes some. Runs when the owner opens the list and whenever
 * a staff member signs in.
 */
async function syncPlanSuspension(ownerUid, list, limit) {
  const updates = {};
  list.forEach((s, i) => {
    const over = i >= limit;
    if (!!s.suspendedByPlan !== over) {
      updates[`${s.id}/suspendedByPlan`] = over;
      s.suspendedByPlan = over;
    }
  });
  if (Object.keys(updates).length) {
    await ref(`${DB_PATHS.STAFF}/${ownerUid}`).update(updates);
  }
  return list;
}

/* ───────────── owner operations ───────────── */
async function listStaff(ownerUid) {
  const info = await getLimitInfo(ownerUid);
  const list = await syncPlanSuspension(ownerUid, await loadAll(ownerUid), info.limit);
  return { staff: list.map(publicView), limit: info.limit, used: list.length, planId: info.planId, planName: info.planName };
}

async function createStaff(ownerUid, input, actor) {
  const info = await getLimitInfo(ownerUid);
  if (info.limit <= 0) {
    throw new StaffError('Staff Management is locked on the Free plan. Upgrade your plan to add staff accounts.', 403, { locked: true });
  }

  const name = cleanText(input.name, { label: 'Name', min: 2, max: 40, required: true });
  const username = cleanUsername(input.username);
  const password = validatePassword(input.password);
  const role = cleanText(input.role, { label: 'Role', max: 30 });
  const duties = cleanText(input.duties, { label: 'Work description', max: 500 });
  const permissions = cleanPermissions(input.permissions);

  const id = 'stf_' + crypto.randomBytes(6).toString('hex');
  const now = Date.now();
  const record = {
    id, name, username, role, duties, permissions,
    isActive: true,
    suspendedByPlan: false,
    passwordHash: await hashPassword(password),
    tokenVersion: 0,
    failedAttempts: 0,
    lockUntil: 0,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    createdBy: actor || 'owner',
  };

  // 1) Reserve the username (globally unique) — atomic, so two owners can
  //    never grab the same one at the same moment.
  const idxRef = ref(`${DB_PATHS.STAFF_INDEX}/${username}`);
  const idx = await idxRef.transaction((cur) => (cur ? undefined : { ownerUid, staffId: id }));
  if (!idx.committed) throw new StaffError('This username is already taken. Please choose another one.', 409, { field: 'username' });

  // 2) Insert under the owner — the plan limit is re-checked INSIDE the
  //    transaction so two quick taps can't squeeze past it.
  let tx;
  try {
    tx = await ref(`${DB_PATHS.STAFF}/${ownerUid}`).transaction((cur) => {
      if (cur === null) return { [id]: record };
      if (Object.keys(cur).length >= info.limit) return undefined;
      cur[id] = record;
      return cur;
    });
  } catch (err) {
    await idxRef.remove().catch(() => {});
    throw err;
  }
  if (!tx.committed) {
    await idxRef.remove().catch(() => {});
    throw new StaffError(
      `Your ${info.planName} plan allows up to ${info.limit} staff account${info.limit === 1 ? '' : 's'}. Remove one or upgrade your plan to add more.`,
      403, { limitReached: true, limit: info.limit }
    );
  }
  logger.info(`Staff created: owner=${ownerUid} staff=${id} username=${username}`);
  return publicView(record);
}

async function getOwned(ownerUid, staffId) {
  const snap = await ref(`${DB_PATHS.STAFF}/${ownerUid}/${staffId}`).once('value');
  if (!snap.exists()) throw new StaffError('Staff account not found.', 404);
  return snap.val();
}

async function updateStaff(ownerUid, staffId, input) {
  const cur = await getOwned(ownerUid, staffId);
  const patch = {};
  if (input.name !== undefined) patch.name = cleanText(input.name, { label: 'Name', min: 2, max: 40, required: true });
  if (input.role !== undefined) patch.role = cleanText(input.role, { label: 'Role', max: 30 });
  if (input.duties !== undefined) patch.duties = cleanText(input.duties, { label: 'Work description', max: 500 });
  if (input.permissions !== undefined) patch.permissions = cleanPermissions(input.permissions);
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') throw new StaffError('Invalid status.');
    if (input.isActive && cur.suspendedByPlan) {
      throw new StaffError('This account is over your current plan limit. Upgrade your plan or remove another staff account first.', 403);
    }
    patch.isActive = input.isActive;
    // Disabling signs the person out everywhere straight away.
    if (!input.isActive) patch.tokenVersion = (cur.tokenVersion || 0) + 1;
  }
  if (!Object.keys(patch).length) throw new StaffError('Nothing to update.');
  patch.updatedAt = Date.now();
  await ref(`${DB_PATHS.STAFF}/${ownerUid}/${staffId}`).update(patch);
  return publicView({ ...cur, ...patch });
}

async function resetPassword(ownerUid, staffId, newPassword) {
  const cur = await getOwned(ownerUid, staffId);
  const password = validatePassword(newPassword);
  await ref(`${DB_PATHS.STAFF}/${ownerUid}/${staffId}`).update({
    passwordHash: await hashPassword(password),
    tokenVersion: (cur.tokenVersion || 0) + 1, // signs them out of every device
    failedAttempts: 0,
    lockUntil: 0,
    updatedAt: Date.now(),
  });
}

/** Signs a staff member out of every device (their tokens carry the old tokenVersion). */
async function forceLogout(ownerUid, staffId) {
  const cur = await getOwned(ownerUid, staffId);
  await ref(`${DB_PATHS.STAFF}/${ownerUid}/${staffId}`).update({ tokenVersion: (cur.tokenVersion || 0) + 1, updatedAt: Date.now() });
}

async function removeStaff(ownerUid, staffId) {
  const cur = await getOwned(ownerUid, staffId);
  await ref(`${DB_PATHS.STAFF}/${ownerUid}/${staffId}`).remove();
  const idxRef = ref(`${DB_PATHS.STAFF_INDEX}/${cur.username}`);
  const idx = await idxRef.once('value');
  if (idx.exists() && idx.val().staffId === staffId) await idxRef.remove();
  logger.info(`Staff removed: owner=${ownerUid} staff=${staffId}`);
}

/* ───────────── staff login ───────────── */
async function login(usernameInput, password) {
  const invalid = () => new StaffError('Invalid username or password.', 401);
  const key = String(usernameInput || '').trim().toLowerCase();
  if (!key || !password || String(password).length > 200) throw invalid();

  const idxSnap = await ref(`${DB_PATHS.STAFF_INDEX}/${key}`).once('value');
  if (!idxSnap.exists()) {
    await hashPassword('timing-equalizer'); // same work as a real attempt → no username enumeration by timing
    throw invalid();
  }
  const { ownerUid, staffId } = idxSnap.val();
  const recRef = ref(`${DB_PATHS.STAFF}/${ownerUid}/${staffId}`);
  const snap = await recRef.once('value');
  if (!snap.exists()) throw invalid();
  let st = snap.val();

  if (st.lockUntil && st.lockUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((st.lockUntil - Date.now()) / 60000));
    throw new StaffError(`Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  }

  if (!(await verifyPassword(String(password), st.passwordHash))) {
    const failed = (st.failedAttempts || 0) + 1;
    await recRef.update(failed >= MAX_FAILED_LOGINS
      ? { failedAttempts: 0, lockUntil: Date.now() + LOCK_MS }
      : { failedAttempts: failed });
    throw invalid();
  }

  // Credentials are right — now tell them precisely why they may still be blocked.
  const ownerSnap = await ref(`${DB_PATHS.USERS}/${ownerUid}`).once('value');
  if (!ownerSnap.exists()) throw invalid();
  const owner = ownerSnap.val();
  if (owner.isBanned) throw new StaffError('This business account is suspended.', 403);

  const info = await getLimitInfo(ownerUid);
  if (info.limit <= 0) throw new StaffError("Staff access isn't available on the owner's current plan.", 403);
  const list = await syncPlanSuspension(ownerUid, await loadAll(ownerUid), info.limit);
  st = list.find((s) => s.id === staffId) || st;
  if (!st.isActive) throw new StaffError('Your staff account has been disabled by the account owner.', 403);
  if (st.suspendedByPlan) throw new StaffError("Your account is over the owner's current plan limit. Ask the owner to upgrade the plan.", 403);

  await recRef.update({ failedAttempts: 0, lockUntil: 0, lastLoginAt: Date.now() });
  return { owner: { uid: ownerUid, ...owner }, staff: st };
}

/** What the panel stores/uses for a staff session (never includes the owner's private details). */
function sessionUser(owner, staff) {
  return {
    uid: owner.uid,
    email: staff.username,
    displayName: staff.name,
    photoURL: '',
    role: 'user',
    isStaff: true,
    staff: { id: staff.id, name: staff.name, username: staff.username, role: staff.role || '', permissions: staff.permissions || [] },
    merchantDisplayName: owner.merchantDisplayName || '',
    showOnboarding: false,
    isBanned: !!owner.isBanned,
  };
}

module.exports = {
  sessionUser,
  StaffError, STAFF_LIMITS_BY_PLAN,
  hashPassword, verifyPassword,
  getLimitInfo, listStaff, createStaff, updateStaff, resetPassword, forceLogout, removeStaff, login,
  publicView,
};

},

// ===== routes/webhook.js =====
"routes/webhook.js": function (module, exports, __r) {
// routes/webhook.js
const express = require('express');
const router = express.Router();
const { handleZapWebhook } = __r("webhooks/zapWebhook.js");

// Zap UPI POSTs to this on every payment status change
// No JWT auth - Zap sends this directly
router.post('/zap', handleZapWebhook);

module.exports = router;

},

// ===== webhooks/zapWebhook.js =====
"webhooks/zapWebhook.js": function (module, exports, __r) {
// webhooks/zapWebhook.js
const firebaseService     = __r("services/firebaseService.js");
const walletService       = __r("services/walletService.js");
const notificationService = __r("services/notificationService.js");
const subscriptionService = __r("services/subscriptionService.js");
const referralService     = __r("services/referralService.js");
const zapService          = __r("services/zapService.js");
const storeService        = __r("services/storeService.js");
const webhookService      = __r("services/webhookService.js");
const { ref }             = __r("firebase/admin.js");
const { DB_PATHS, DEFAULT_PLANS } = __r("config/constants.js");
const logger              = __r("utils/logger.js");

async function handleZapWebhook(req, res) {
  const { order_id, status, txn_id, amount, pay_amount, utr, environment } = req.body;
  if (!order_id) {
    logger.warn('Webhook: missing order_id');
    return res.status(200).json({ status: 'ok' });
  }
  logger.info(`Webhook: ${order_id} status=${status}`);

  await processWebhookAsync({ order_id, status, txn_id, amount, pay_amount, utr, environment });

  return res.status(200).json({ status: 'ok' });
}

async function processWebhookAsync(data) {
  const { order_id, status, txn_id, amount, pay_amount, utr, environment } = data;
  try {
    const payment = await firebaseService.getPayment(order_id);
    if (!payment) { logger.error(`Payment not found: ${order_id}`); return; }

    // ─── Normalize status ──────────────────────────────────────────
    const normalize = (s) => {
      const v = String(s || '').trim().toLowerCase();
      if (v === 'success') return 'Success';
      if (v === 'failed'
        || v.startsWith('cancel')
        || v.startsWith('reject')
        || v.startsWith('decline')
        || v.startsWith('expire')
      ) return 'Failed';
      if (v === 'pending') return 'Pending';
      return null;
    };

    let verifiedStatus = normalize(status);
    if (verifiedStatus !== 'Success' && verifiedStatus !== 'Failed') {
      try {
        const api = await zapService.getOrderStatus(order_id);
        const apiStatus = normalize(api.status);
        if (apiStatus === 'Success' || apiStatus === 'Failed') {
          verifiedStatus = apiStatus;
        }
      } catch (e) { logger.warn(`API verify failed: ${e.message}`); }
    } else {
      try {
        const api = await zapService.getOrderStatus(order_id);
        const apiStatus = normalize(api.status);
        if (apiStatus && apiStatus !== verifiedStatus) {
          logger.warn(`Webhook/API mismatch ${order_id}: webhook=${verifiedStatus}, API=${apiStatus} — trusting webhook`);
        }
      } catch (e) { /* non-critical */ }
    }

    // ─── Duplicate prevention ──────────────────────────────────────
    // Status-aware: only skips a REPEAT delivery of the same final status
    // for this order (e.g. Zap retrying its own webhook). A genuine status
    // transition for the same order — most importantly Failed → Success,
    // when a payment that first reported as failed is later confirmed —
    // is NOT a duplicate and must still update the DB and notify the user.
    if (await firebaseService.isOrderProcessed(order_id, verifiedStatus)) {
      logger.warn(`Duplicate ignored: ${order_id} (status=${verifiedStatus})`); return;
    }
    await firebaseService.markOrderProcessed(order_id, verifiedStatus);

    await firebaseService.updatePaymentStatus(order_id, { status: verifiedStatus, txn_id, utr, amount, pay_amount, environment });

    if (verifiedStatus !== 'Success' && verifiedStatus !== 'Failed') {
      await firebaseService.unmarkOrderProcessed(order_id);
      logger.warn(`Webhook ${order_id}: inconclusive status (raw="${status}"), released claim for retry`);
      return;
    }

    if (verifiedStatus !== 'Success') {
      // ─── Failure notification ────────────────────────────────────
      let title = '❌ Payment Failed';
      let message = `Your payment of ₹${amount} failed. Order: ${order_id}`;
      if (payment.type === 'subscription' && payment.planId) {
        title = '❌ Subscription Payment Failed';
        message = `Your plan upgrade payment of ₹${amount} failed. Order: ${order_id}`;
      } else if (payment.storeId) {
        title = '⚠️ Purchase Attempt Failed';
        message = `A customer's ₹${amount} purchase from your store did not go through. Order: ${order_id}`;
      } else if (payment.linkId) {
        title = '⚠️ Payment Attempt Failed';
        message = `A customer's payment of ₹${amount} via your payment link did not go through. Order: ${order_id}`;
      }
      await notificationService.createNotification(payment.userId, { title, message, type: 'payment' });

      webhookService.notifyUserWebhooks(payment.userId, 'order.failed', {
        order_id, status: 'failed', amount: parseFloat(amount || 0),
      }).catch((e) => logger.warn(`notifyUserWebhooks(failed) error: ${e.message}`));

      return;
    }

    const grossAmount = parseFloat(pay_amount || amount || 0);
    if (grossAmount <= 0) return;

    // ─── ──────────────────────────────────────────────────────────────
    // ─── CRITICAL FIX: FamPay/Cashier Payments — NO Wallet Credit ──
    // If payment method is 'fampay' or routingEngine is 'cashier',
    // the merchant already received money in their FamPay account.
    // DO NOT credit ZapPay wallet again. Just mark success + notify.
    //
    // EXCEPTION: wallet_topup, zap_credit_topup, and store_unlock orders
    // are a user paying ZAPPAY ITSELF (their own wallet, their own Zap
    // Credit, or a one-time platform feature-unlock) — never a customer
    // paying a separate merchant. When systemRoutingMode is 'self' (see
    // paymentController.js's/storeController.js's createOrder), EVERY
    // order type gets paymentMethod:'fampay' — including these three —
    // since that field only describes which cashier handled the bank
    // rail, not who owns the money. Skipping the credit here silently
    // ate 100% of FamPay-routed top-ups and unlocks: the money left the
    // customer's bank, the cashier's FamPay received it, and this early-
    // return meant nothing ever finished the platform-side effect (wallet
    // credit / Zap Credit credit / store unlock) — exactly the reported
    // bugs: a ₹50 Zap Credit purchase that never landed, and a ₹29 store
    // unlock via UPI that never unlocked (while the Wallet-pay path,
    // which never touches this webhook, worked instantly). These three
    // types must still fall through to their normal handlers below
    // regardless of paymentMethod/routingEngine.
    // ─── ──────────────────────────────────────────────────────────────
    const isSelfFundingTopup = payment.type === 'wallet_topup' || payment.type === 'zap_credit_topup' || payment.type === 'store_unlock';
    if (!isSelfFundingTopup && (payment.paymentMethod === 'fampay' || payment.routingEngine === 'cashier')) {
      logger.info(`FamPay/Cashier payment ${order_id} — skipping wallet credit (merchant already received money in FamPay)`);

      await notificationService.createNotification(payment.userId, {
        title: '✅ Payment Received via FamPay',
        message: `₹${grossAmount} has been received in your FamPay account. Order: ${order_id}`,
        type: 'payment',
      });

      await firebaseService.logActivity(payment.userId, 'FAMPAY_PAYMENT_RECEIVED', {
        orderId: order_id,
        amount: grossAmount,
        utr: utr || null,
      });

      await webhookService.notifyUserWebhooks(payment.userId, 'order.success', {
        order_id, status: 'success', amount: grossAmount, utr: utr || null,
      }).catch((e) => logger.warn(`Webhook notify error: ${e.message}`));

      return;
    }

    // ─── Outgoing webhook for success (non-FamPay) ──────────────────
    webhookService.notifyUserWebhooks(payment.userId, 'order.success', {
      order_id, status: 'success', amount: grossAmount, utr: utr || null,
    }).catch((e) => logger.warn(`notifyUserWebhooks(success) error: ${e.message}`));

    // ─── SUBSCRIPTION PAYMENT ──────────────────────────────────────
    if (payment.type === 'subscription' && payment.planId) {
      await handleSubscriptionPayment(payment, grossAmount, order_id);
      return;
    }

    // ─── STORE UNLOCK ──────────────────────────────────────────────
    if (payment.type === 'store_unlock') {
      await handleStoreUnlockPayment(payment, grossAmount, order_id);
      return;
    }

    // ─── STORE PORTAL PURCHASE ─────────────────────────────────────
    if (payment.storeId) {
      await handleStorePurchase(payment, grossAmount, order_id, utr);
      return;
    }

    // ─── ZAP CREDIT TOP-UP (direct, via UPI) ────────────────────────
    if (payment.type === 'zap_credit_topup') {
      await handleZapCreditTopup(payment, grossAmount, order_id);
      return;
    }

    // ─── ZAPAPI ORDER (developer-created, no linkId) ────────────────
    // Was previously falling into the `!payment.linkId` wallet-topup
    // branch below purely because it also lacks a linkId — but a
    // wallet-topup is the merchant funding their OWN wallet (no
    // commission owed), while a ZapAPI order is a CUSTOMER paying the
    // merchant through their own website/app (commission owed, exactly
    // like a payment-link order). That misrouting meant ZapAPI orders
    // never had Zap Credit debited at all. Must be checked before the
    // wallet-topup fallback below, since both share "no linkId".
    if (payment.type === 'api') {
      await handleApiOrderPayment(payment, grossAmount, order_id, utr);
      return;
    }

    // ─── WALLET TOP-UP (direct) ────────────────────────────────────
    if (!payment.linkId) {
      await handleWalletTopup(payment, grossAmount, order_id);
      if (payment.type === 'wallet_topup') {
        await referralService.processQualifyingDeposit(payment.userId, grossAmount);
      }
      return;
    }

    // ─── PAYMENT LINK PAYMENT ─────────────────────────────────────
    await handleLinkPayment(payment, grossAmount, order_id, utr);

  } catch (err) {
    logger.error(`Webhook error ${order_id}:`, err.message);
  }
}

// ─── SUBSCRIPTION PAYMENT ────────────────────────────────────────
async function handleSubscriptionPayment(payment, amount, orderId) {
  try {
    const plan = await subscriptionService.getPlan(payment.planId) || DEFAULT_PLANS[payment.planId];
    if (!plan) { logger.error(`Plan not found: ${payment.planId}`); return; }

    const durationDays = payment.durationDays || 30;
    const durationLabel = payment.durationMonths && payment.durationMonths !== 1
      ? `${payment.durationMonths} months`
      : `${durationDays} days`;

    await subscriptionService.activateSubscription(payment.userId, payment.planId, durationDays);

    if (payment.couponId) {
      try { await __r("services/airdropService.js").markCouponUsed(payment.userId, payment.couponId, orderId); }
      catch (couponErr) { logger.error(`Could not mark coupon used (${payment.couponId}): ${couponErr.message}`); }
    }

    await notificationService.createNotification(payment.userId, {
      title: `🎉 ${plan.name} Plan Activated!`,
      message: `Your ${plan.name} subscription is now active for ${durationLabel}. Payment ₹${amount} confirmed.`,
      type: 'subscription',
    });

    await firebaseService.logActivity(payment.userId, 'SUBSCRIPTION_ACTIVATED', {
      planId: payment.planId, planName: plan.name, amount, orderId, durationDays,
    });

    logger.info(`Subscription activated: ${payment.userId} → ${payment.planId} (${durationDays}d)`);
  } catch (err) {
    logger.error(`Subscription activation failed: ${err.message}`);
  }
}

// ─── WALLET TOP-UP ──────────────────────────────────────────────
async function handleWalletTopup(payment, amount, orderId) {
  // NOTE: the "already processed?" re-fetch-and-skip guard that used to be
  // here was removed — see the comment in handleLinkPayment above for why:
  // updatePaymentStatus() has already written status:'success' to the DB
  // by the time this function runs, so re-checking it here always looked
  // like a duplicate and skipped crediting the wallet on every real
  // top-up. Duplicate-delivery protection is handled earlier and
  // correctly via isOrderProcessed/markOrderProcessed.

  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance  = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  if (available <= 0) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full',
      message: `Payment of ₹${amount} received but wallet is full (limit ₹${plan.walletLimit}). Please withdraw first.`,
      type: 'payment',
    });
    return;
  }

  const credit = Math.min(amount, available);
  await walletService.creditWallet(payment.userId, credit, `Top-up ${orderId}`);
  try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }

  await notificationService.createNotification(payment.userId, {
    title: '💰 Wallet Credited',
    message: `₹${credit} added to your wallet. Order: ${orderId}`,
    type: 'payment',
  });

  await firebaseService.logActivity(payment.userId, 'WALLET_TOPUP', { orderId, amount: credit });
  logger.info(`Wallet top-up: ${payment.userId} +₹${credit}`);
}

// ─── ZAP CREDIT TOP-UP (via UPI) ──────────────────────────────────
// Unlike Zap Cash, Zap Credit has no plan-based wallet limit — it's not
// withdrawable real money, just "fuel" spent on commission. So the full
// paid amount always credits, no partial/available-space capping needed.
async function handleZapCreditTopup(payment, amount, orderId) {
  // See handleLinkPayment's comment above — same stale-guard bug, removed
  // for the same reason (the DB already shows 'success' by this point in
  // every real invocation, so this always false-flagged as a duplicate).

  const newBalance = await walletService.creditZapCredit(payment.userId, amount, `UPI Top-up ${orderId}`);

  await notificationService.createNotification(payment.userId, {
    title: '⚡ Zap Credit Added',
    message: `${amount} Zap Credit added to your account. Order: ${orderId}`,
    type: 'payment',
  });

  await firebaseService.logActivity(payment.userId, 'ZAP_CREDIT_TOPUP', { orderId, amount });
  logger.info(`Zap Credit top-up: ${payment.userId} +${amount} (balance: ${newBalance})`);
}

// ─── ZAPAPI ORDER PAYMENT ─────────────────────────────────────────
// A customer paying a merchant through the merchant's own website/app via
// ZapAPI — commission is owed exactly like a payment-link order, just
// with no paymentLinks/{linkId} stats to update since there's no link
// involved. Mirrors handleLinkPayment's wallet-full / commission logic;
// see that function's comments for why wallet-full only blocks the cash
// credit, never the commission.
async function handleApiOrderPayment(payment, grossAmount, orderId, utr) {
  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance   = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  let walletFull = available <= 0;
  let credit = 0;
  if (walletFull) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full',
      message: `Payment ₹${grossAmount} received via ZapAPI but wallet full. Withdraw funds.`,
      type: 'payment',
    });
  } else {
    credit = Math.min(grossAmount, available);
    await walletService.creditWallet(payment.userId, credit, `API Order ${orderId}`);
    try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }
  }

  // ─── Zap Credit deduction (unconditional — see handleLinkPayment) ──
  const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
  const creditCost = Math.round((grossAmount * commissionPct) / 100 * 100) / 100;
  if (creditCost > 0) {
    try {
      await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
    } catch (e) {
      logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
    }
  }

  // (order.success webhook already fired in processWebhookAsync above,
  // before type-specific routing — not repeated here)

  if (!walletFull) {
    await notificationService.createNotification(payment.userId, {
      title: '💰 Payment Received via ZapAPI',
      message: `₹${credit} credited to your wallet. Order: ${orderId}`,
      type: 'payment',
    });
  }

  await firebaseService.logActivity(payment.userId, 'API_ORDER_PAYMENT_SUCCESS', {
    orderId, grossAmount, netAmount: credit, utr,
  });

  logger.info(`ZapAPI order payment: ${payment.userId} +₹${credit} (commission ₹${creditCost})`);
}

// ─── PAYMENT LINK PAYMENT ────────────────────────────────────────
async function handleLinkPayment(payment, grossAmount, orderId, utr) {
  // NOTE: there used to be a second "already processed?" guard here that
  // re-fetched the payment and skipped crediting if its status was
  // already 'success'. That's actively wrong: updatePaymentStatus() (in
  // processWebhookAsync, above) already writes status:'success' to the DB
  // BEFORE handleLinkPayment ever runs — so this guard was reading back
  // the write this same webhook invocation just made, one line earlier,
  // and always skipping wallet credit as a false "duplicate". Real
  // duplicate-delivery protection already happens earlier via
  // isOrderProcessed/markOrderProcessed (status-aware, checked before any
  // DB write occurs), so it doesn't need to be repeated — incorrectly —
  // here.

  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance   = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  // Wallet-full only blocks the CASH credit — commission is owed on this
  // order regardless, since the customer already paid successfully. This
  // used to `return` here before the Zap Credit deduction below ever ran,
  // meaning a merchant with a full wallet paid zero commission on every
  // order that overflowed it. It also used to skip updating the link's
  // paymentCount/totalCollected and the success notification below — the
  // same "Paid 0x despite a real successful order" symptom as before, just
  // triggered by a full wallet instead of a crash. Wallet-full and
  // order-succeeded are two separate facts and must not gate each other.
  let walletFull = available <= 0;
  let credit = 0;
  if (walletFull) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full',
      message: `Payment ₹${grossAmount} received but wallet full. Withdraw funds.`,
      type: 'payment',
    });
  } else {
    credit = Math.min(grossAmount, available);
    await walletService.creditWallet(payment.userId, credit, `Link ${payment.linkId}`);
    try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }
  }

  // ─── Zap Credit deduction (unconditional — see comment above) ──
  const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
  const creditCost = Math.round((grossAmount * commissionPct) / 100 * 100) / 100;
  if (creditCost > 0) {
    try {
      await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
    } catch (e) {
      logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
    }
  }

  // ─── Link stats + success notification (unconditional) ─────────
  const linkRef = ref(`${DB_PATHS.PAYMENT_LINKS}/${payment.linkId}`);
  const linkSnap = await linkRef.once('value');
  const linkData = linkSnap.val();
  if (linkData) {
    await linkRef.update({
      paymentCount: (linkData.paymentCount || 0) + 1,
      totalCollected: (linkData.totalCollected || 0) + grossAmount,
      lastPaidAt: Date.now(),
    });
  }

  if (!walletFull) {
    await notificationService.createNotification(payment.userId, {
      title: '💰 Payment Received via Link',
      message: `₹${credit} credited to your wallet. Order: ${orderId}`,
      type: 'payment',
    });
  }

  await firebaseService.logActivity(payment.userId, 'PAYMENT_SUCCESS', {
    orderId, grossAmount, netAmount: credit, linkId: payment.linkId, utr,
  });

  logger.info(`Link payment: ${payment.userId} +₹${credit}`);
}

// ─── STORE UNLOCK ────────────────────────────────────────────────
async function handleStoreUnlockPayment(payment, amount, orderId) {
  try {
    await storeService.setUnlocked(payment.userId, true);

    await notificationService.createNotification(payment.userId, {
      title: '🎉 Store Unlocked!',
      message: `Your ZapPay Store is now unlocked (₹${amount} confirmed) — customize it and start selling!`,
      type: 'general',
    });

    await firebaseService.logActivity(payment.userId, 'STORE_UNLOCKED_UPI', { amount, orderId });
    logger.info(`Store unlocked via UPI: ${payment.userId}`);
  } catch (err) {
    logger.error(`Store unlock activation failed: ${err.message}`);
  }
}

// ─── STORE PURCHASE ──────────────────────────────────────────────
async function handleStorePurchase(payment, grossAmount, orderId, utr) {
  // Same stale-guard bug as handleLinkPayment/handleWalletTopup/
  // handleZapCreditTopup above — removed for the same reason.

  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance   = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  // See handleLinkPayment's comment on this same pattern — wallet-full
  // only blocks the cash credit and its notification/stats, never the
  // commission owed, nor the product's own sales stats, since the order
  // itself succeeded either way.
  let walletFull = available <= 0;
  let credit = 0;
  if (walletFull) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full — Sale Still Recorded',
      message: `A product sold for ₹${grossAmount} but your wallet is full, so cash wasn't credited. Withdraw funds to receive future sales.`,
      type: 'payment',
    });
  } else {
    credit = Math.min(grossAmount, available);
    await walletService.creditWallet(payment.userId, credit, `Store ${payment.storeId} product ${payment.productId}`);
    try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }
  }

  // ─── Zap Credit deduction (unconditional — see comment above) ──
  const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
  const creditCost = Math.round((grossAmount * commissionPct) / 100 * 100) / 100;
  if (creditCost > 0) {
    try {
      await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
    } catch (e) {
      logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
    }
  }

  // ─── Product sales stats + success notification (unconditional) ─
  let productTitle = 'Product';
  if (payment.productId) {
    const productRef = ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`);
    const productSnap = await productRef.once('value');
    const productData = productSnap.val();
    if (productData) {
      productTitle = productData.title || productTitle;
      await productRef.update({
        salesCount: (productData.salesCount || 0) + 1,
        totalCollected: (productData.totalCollected || 0) + grossAmount,
        lastSoldAt: Date.now(),
      });
    }
  }

  if (!walletFull) {
    await notificationService.createNotification(payment.userId, {
      title: '🛍️ Product Sold!',
      message: `"${productTitle}" sold for ₹${credit}, credited to your wallet. Order: ${orderId}`,
      type: 'payment',
    });
  }

  await firebaseService.logActivity(payment.userId, 'STORE_SALE', {
    orderId, grossAmount, netAmount: credit, storeId: payment.storeId, productId: payment.productId, utr,
  });

  logger.info(`Store sale: ${payment.userId} +₹${credit} (product ${payment.productId})`);
}

module.exports = { handleZapWebhook };

},

// ===== services/storeService.js =====
"services/storeService.js": function (module, exports, __r) {
// services/storeService.js - Store Portal data layer
//
// Every merchant gets ONE store (auto-created on first touch of Store
// Portal) holding: settings (name/logo/theme/social links) + an unlimited
// (well, capped) list of products. Customers reach it publicly via
// store.html?id=<storeId> — storeId is a short public identifier, never
// the merchant's Firebase uid, resolved through STORE_ID_INDEX the same
// way ZapAPI keys resolve through API_TOKENS.
const crypto = require('crypto');
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");

const MAX_SCREENSHOTS = 8;
const MAX_PRODUCTS = 300; // a sane technical safety cap, not a plan/business restriction
const VALID_THEMES = ['boutique', 'editorial', 'market']; // <-- FIX: editorial added

function generateStoreId() {
  return crypto.randomBytes(4).toString('hex'); // e.g. "a1b2c3d4"
}
function generateProductId() {
  return crypto.randomBytes(6).toString('hex');
}

const DEFAULT_LOGO_URL = 'https://res.cloudinary.com/dihj6dmbb/image/upload/v1782028733/quickurl/20260621132708_1782028720083.png';

/**
 * Get a merchant's store settings, auto-creating a default store (with a
 * freshly generated, collision-checked storeId) the first time they ever
 * touch Store Portal.
 */
async function getOrCreateSettings(uid) {
  const settingsRef = ref(`${DB_PATHS.STORES}/${uid}/settings`);
  const snap = await settingsRef.once('value');
  if (snap.exists()) return snap.val();

  let storeId = generateStoreId();
  while ((await ref(`${DB_PATHS.STORE_ID_INDEX}/${storeId}`).once('value')).exists()) {
    storeId = generateStoreId();
  }

  const defaults = {
    storeId,
    storeName: 'ZapPay Store',
    logoUrl: DEFAULT_LOGO_URL,
    theme: 'boutique',
    socialLinks: { telegram: '', whatsapp: '', youtube: '', instagram: '' },
    unlocked: false,
    showSortButton: false,   // <-- NEW: toggle for sort on storefront
    categories: [],          // <-- NEW: [{ id, name, icon }]
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await settingsRef.set(defaults);
  await ref(`${DB_PATHS.STORE_ID_INDEX}/${storeId}`).set(uid);
  return defaults;
}

/**
 * System-managed unlock flag — deliberately not exposed through
 * updateSettings' user-editable fields below. Only ever called from
 * storeController's wallet-unlock handler and the store_unlock webhook
 * branch, never directly from a merchant-facing form.
 */
async function setUnlocked(uid, value) {
  await getOrCreateSettings(uid);
  await ref(`${DB_PATHS.STORES}/${uid}/settings`).update({ unlocked: !!value, updatedAt: serverTimestamp() });
}

/** Merchant-facing settings update — only ever touches known-safe fields. */
async function updateSettings(uid, data) {
  await getOrCreateSettings(uid);
  const updates = { updatedAt: serverTimestamp() };

  if (data.storeName !== undefined) {
    const name = String(data.storeName).trim().slice(0, 60);
    updates.storeName = name || 'ZapPay Store';
  }
  if (data.logoUrl !== undefined) {
    const url = String(data.logoUrl).trim().slice(0, 500);
    updates.logoUrl = url || DEFAULT_LOGO_URL;
  }
  if (data.theme !== undefined) {
    if (!VALID_THEMES.includes(data.theme)) throw new Error(`Invalid theme: ${data.theme}`);
    updates.theme = data.theme;
  }
  if (data.socialLinks !== undefined && typeof data.socialLinks === 'object' && data.socialLinks !== null) {
    const sl = data.socialLinks;
    updates.socialLinks = {
      telegram: String(sl.telegram || '').trim().slice(0, 300),
      whatsapp: String(sl.whatsapp || '').trim().slice(0, 300),
      youtube: String(sl.youtube || '').trim().slice(0, 300),
      instagram: String(sl.instagram || '').trim().slice(0, 300),
    };
  }

  // ─── NEW: Show Sort Button toggle ──────────────────────────────
  if (data.showSortButton !== undefined) {
    updates.showSortButton = !!data.showSortButton;
  }

  // ─── NEW: Categories array ──────────────────────────────────────
  if (data.categories !== undefined && Array.isArray(data.categories)) {
    const valid = data.categories.filter(c => c && c.name && c.name.trim());
    updates.categories = valid.map(c => ({
      id: c.id || 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: c.name.trim().slice(0, 30),
      icon: (c.icon || '').trim().slice(0, 30) || null,
    }));
  }

  await ref(`${DB_PATHS.STORES}/${uid}/settings`).update(updates);
  const snap = await ref(`${DB_PATHS.STORES}/${uid}/settings`).once('value');
  return snap.val();
}

async function getProducts(uid) {
  const snap = await ref(`${DB_PATHS.STORES}/${uid}/products`).once('value');
  if (!snap.exists()) return [];
  return Object.values(snap.val()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function getProduct(uid, productId) {
  const snap = await ref(`${DB_PATHS.STORES}/${uid}/products/${productId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Validates + sanitizes product input. `partial: true` (for updates) only
 * validates fields that were actually supplied; create always requires
 * the four mandatory fields regardless of what was sent.
 */
function validateProductInput(data, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || data.imageUrl !== undefined) {
    const v = String(data.imageUrl || '').trim();
    if (!v) errors.push('Product image URL is required');
    out.imageUrl = v.slice(0, 500);
  }
  if (!partial || data.title !== undefined) {
    const v = String(data.title || '').trim();
    if (!v) errors.push('Product title is required');
    out.title = v.slice(0, 120);
  }
  if (!partial || data.description !== undefined) {
    const v = String(data.description || '').trim();
    if (!v) errors.push('Product description is required');
    out.description = v.slice(0, 3000);
  }
  if (!partial || data.originalPrice !== undefined) {
    const v = parseFloat(data.originalPrice);
    if (!v || v <= 0) errors.push('Original price is required and must be greater than 0');
    out.originalPrice = v;
  }
  if (data.discountPrice !== undefined) {
    if (data.discountPrice === null || data.discountPrice === '') {
      out.discountPrice = null;
    } else {
      const v = parseFloat(data.discountPrice);
      const base = out.originalPrice !== undefined ? out.originalPrice : null;
      if (isNaN(v) || v < 0) errors.push('Discount price must be a valid non-negative number');
      else if (base !== null && v >= base) errors.push('Discount price must be less than the original price');
      out.discountPrice = v;
    }
  }
  if (data.productLink !== undefined) {
    out.productLink = String(data.productLink || '').trim().slice(0, 1000);
  }
  if (data.videoLink !== undefined) {
    const v = String(data.videoLink || '').trim();
    if (!v) {
      out.videoLink = null;
    } else if (!/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/.test(v)) {
      // Validated server-side too, not just in the panel's form — an API
      // caller (ZapAPI, or a future integration) could otherwise store an
      // arbitrary URL here, which the storefront would then render as a
      // trusted YouTube embed.
      errors.push('Video Link must be a valid YouTube URL');
    } else {
      out.videoLink = v.slice(0, 500);
    }
  }
  if (data.screenshotUrls !== undefined) {
    if (!Array.isArray(data.screenshotUrls)) {
      errors.push('screenshotUrls must be a list of URLs');
      out.screenshotUrls = [];
    } else {
      if (data.screenshotUrls.length > MAX_SCREENSHOTS) errors.push(`Maximum ${MAX_SCREENSHOTS} screenshots allowed`);
      out.screenshotUrls = data.screenshotUrls.map((s) => String(s || '').trim()).filter(Boolean).slice(0, MAX_SCREENSHOTS);
    }
  }

  // ─── NEW: Category ID support ──────────────────────────────────
  if (data.categoryId !== undefined) {
    out.categoryId = data.categoryId || null;
  }

  return { errors, data: out };
}

async function createProduct(uid, input) {
  const { errors, data } = validateProductInput(input, { partial: false });
  if (errors.length) { const e = new Error(errors[0]); e.validationErrors = errors; throw e; }

  const existing = await getProducts(uid);
  if (existing.length >= MAX_PRODUCTS) throw new Error(`You've reached the maximum of ${MAX_PRODUCTS} products.`);

  await getOrCreateSettings(uid);

  const id = generateProductId();
  const product = {
    id,
    imageUrl: data.imageUrl,
    title: data.title,
    description: data.description,
    originalPrice: data.originalPrice,
    discountPrice: data.discountPrice ?? null,
    productLink: data.productLink || '',
    videoLink: data.videoLink || null,
    screenshotUrls: data.screenshotUrls || [],
    categoryId: data.categoryId || null, // <-- NEW
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await ref(`${DB_PATHS.STORES}/${uid}/products/${id}`).set(product);
  return product;
}

async function updateProduct(uid, productId, input) {
  const existing = await getProduct(uid, productId);
  if (!existing) { const e = new Error('Product not found'); e.notFound = true; throw e; }

  const { errors, data } = validateProductInput(input, { partial: true });
  if (errors.length) { const e = new Error(errors[0]); e.validationErrors = errors; throw e; }

  const updates = { ...data, updatedAt: serverTimestamp() };
  await ref(`${DB_PATHS.STORES}/${uid}/products/${productId}`).update(updates);
  return { ...existing, ...updates };
}

async function deleteProduct(uid, productId) {
  const existing = await getProduct(uid, productId);
  if (!existing) { const e = new Error('Product not found'); e.notFound = true; throw e; }
  await ref(`${DB_PATHS.STORES}/${uid}/products/${productId}`).remove();
}

/** storeId -> uid, for the public storefront. Returns null if unknown. */
async function getUidByStoreId(storeId) {
  const snap = await ref(`${DB_PATHS.STORE_ID_INDEX}/${storeId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

module.exports = {
  getOrCreateSettings,
  updateSettings,
  setUnlocked,
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getUidByStoreId,
  VALID_THEMES,
  MAX_SCREENSHOTS,
  MAX_PRODUCTS,
};

},

// ===== routes/developer.js =====
"routes/developer.js": function (module, exports, __r) {
// routes/developer.js - Developer Portal / ZapAPI
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/developerController.js");
const webhookCtrl = __r("controllers/webhookController.js");
const { authenticate, blockIfBanned, blockIfImpersonating } = __r("middleware/auth.js");
const { authenticateApiKey } = __r("middleware/apiKeyAuth.js");
const { apiKeyLimiter, cancelOrderLimiter } = __r("middleware/rateLimiter.js");
const { requireAdmin } = __r("middleware/adminAuth.js"); // Added for check-order security

// Dashboard-authenticated (JWT) — Developer Portal -> Zap API page
router.get('/token', authenticate, blockIfBanned, ctrl.getMyToken);
router.post('/token/regenerate', authenticate, blockIfBanned, ctrl.regenerateMyToken);

// Gateway Test/Live mode toggle & Routing
router.get('/mode', authenticate, blockIfBanned, ctrl.getMode);
router.post('/mode', authenticate, blockIfBanned, blockIfImpersonating, ctrl.setMode);
router.post('/routing', authenticate, blockIfBanned, blockIfImpersonating, ctrl.setRoutingEngine);

// Webhook URLs
router.get('/webhooks', authenticate, blockIfBanned, webhookCtrl.listWebhooks);
router.post('/webhooks', authenticate, blockIfBanned, blockIfImpersonating, webhookCtrl.addWebhookValidation, webhookCtrl.addWebhook);
router.delete('/webhooks/:webhookId', authenticate, blockIfBanned, blockIfImpersonating, webhookCtrl.deleteWebhook);
router.put('/webhooks/:webhookId/toggle', authenticate, blockIfBanned, blockIfImpersonating, webhookCtrl.toggleWebhook);

// ZapAPI-key authenticated
router.post('/create-order', apiKeyLimiter, authenticateApiKey, ctrl.createOrderValidation, ctrl.createOrder);
router.get('/order-status/:orderId', apiKeyLimiter, authenticateApiKey, ctrl.getOrderStatus);

// Public Order Status for Checkout.html (No Auth Required - Auto Verify Throttled)
router.get('/public-order-status/:orderId', ctrl.getPublicOrderStatus);
router.get('/public-order-peek/:orderId', ctrl.publicOrderPeek);

// Cancel Order from Checkout.html (No Auth Required - IP Rate Limited)
router.post('/cancel-order', cancelOrderLimiter, ctrl.cancelOrder);

// Manual UTR / Txn ID Verification from Checkout page (No Auth Required)
router.post('/verify-utr', ctrl.verifyUtr);

// Full JSON Order Check (Admin/Debug Only)
router.get('/check-order/:orderId', authenticate, blockIfBanned, requireAdmin, ctrl.checkFullOrderJson);

module.exports = router;

},

// ===== controllers/developerController.js =====
"controllers/developerController.js": function (module, exports, __r) {
// controllers/developerController.js - ZapAPI Developer Platform
const { body, validationResult } = require('express-validator');
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const zapService = __r("services/zapService.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const subscriptionService = __r("services/subscriptionService.js");
const apiTokenService = __r("services/apiTokenService.js");
const gatewayModeService = __r("services/gatewayModeService.js");
const webhookService = __r("services/webhookService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const { buildCheckoutUrl } = __r("utils/checkoutUrlBuilder.js");

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
    return response.success(res, 'Status fetched', { order_id: orderId, status: payment.status, amount: payment.amount, ...__r("services/merchantPromoService.js").orderPromoFields(payment) });
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
            ? __r("services/paytmService.js")
            : (payment.paymentMethod === 'amazon'
              ? __r("services/amazonService.js")
              : __r("services/fampayService.js"));
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
      ...__r("services/merchantPromoService.js").orderPromoFields(payment),
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
          ? __r("services/paytmService.js")
          : (payment.paymentMethod === 'amazon'
            ? __r("services/amazonService.js")
            : __r("services/fampayService.js"));
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
        ? __r("services/amazonService.js")
        : __r("services/fampayService.js")).peekLatestTransaction(orderId);
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

},

// ===== services/apiTokenService.js =====
"services/apiTokenService.js": function (module, exports, __r) {
// services/apiTokenService.js - ZapAPI Developer Token Management
//
// Lets a ZapPay merchant accept payments on THEIR OWN website/app using a
// token issued by ZapPay itself — a "ZapAPI" key — the same way ZapPay
// accepts payments using Zap UPI Gateway's own "ZAPKEY".
//   ZapUpi  -> ZAPKEY  (ZapPay is the merchant, calling Zap UPI Gateway)
//   ZapPay  -> ZAPAPI  (a ZapPay user is the merchant, calling ZapPay)
//
// One active key per user. Regenerating immediately invalidates the old
// one (the reverse-lookup index entry is deleted before the new one is
// written, so a key is never valid for two different users at once).
const crypto = require('crypto');
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");

// No ambiguous look-alike characters (0/O, 1/I/l) — keeps the key easy to
// read back and re-type correctly if a merchant is copying it by hand.
// Includes digits (2-9) alongside letters, per spec.
const TOKEN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TOKEN_PREFIX = 'ZPP';
const TOKEN_SUFFIX = 'SX';
const RANDOM_LENGTH = 30; // + 3-char prefix + 2-char suffix = 35 total
const TOKEN_LENGTH = TOKEN_PREFIX.length + RANDOM_LENGTH + TOKEN_SUFFIX.length;

function generateTokenString() {
  const bytes = crypto.randomBytes(RANDOM_LENGTH);
  let middle = '';
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    middle += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  }
  return TOKEN_PREFIX + middle + TOKEN_SUFFIX;
}

/**
 * Get a user's existing ZapAPI key, creating one on first call.
 */
async function getOrCreateToken(userId) {
  const userTokenRef = ref(`${DB_PATHS.USERS}/${userId}/apiToken`);
  const snap = await userTokenRef.once('value');
  // Only reuse the existing key if it actually matches the CURRENT spec.
  // Keys issued before TOKEN_LENGTH was raised to 32 are shorter (e.g. 16
  // chars) and were being returned as-is forever, since this check never
  // verified length — that's why "already changed to 32" never showed up
  // for existing users. A short key now falls through to regenerateToken,
  // which issues a fresh 32-char one (and properly retires the old one).
  if (snap.exists() && snap.val() && snap.val().key && snap.val().key.length === TOKEN_LENGTH) {
    return snap.val();
  }
  return regenerateToken(userId);
}

/**
 * Issue a brand new ZapAPI key for a user, replacing any previous one.
 * The old key stops resolving immediately.
 */
async function regenerateToken(userId) {
  const userTokenRef = ref(`${DB_PATHS.USERS}/${userId}/apiToken`);
  const existingSnap = await userTokenRef.once('value');
  const existing = existingSnap.exists() ? existingSnap.val() : null;

  if (existing && existing.key) {
    await ref(`${DB_PATHS.API_TOKENS}/${existing.key}`).remove();
  }

  const key = generateTokenString();
  const record = {
    key,
    // Date.now() (not serverTimestamp()) — this exact `record` object is
    // returned straight to the API response below, never re-read from the
    // DB first. serverTimestamp() only resolves to a real number once
    // Firebase writes it; until then it's a placeholder object, which is
    // why the dashboard was showing "Created Invalid Date".
    createdAt: Date.now(),
    lastUsedAt: null,
  };

  await userTokenRef.set(record);
  await ref(`${DB_PATHS.API_TOKENS}/${key}`).set(userId);

  return record;
}

/**
 * Resolve a ZapAPI key to its owning userId. Returns null if the key
 * doesn't exist (never issued, or replaced by a regenerate).
 */
async function resolveToken(key) {
  if (!key) return null;
  const snap = await ref(`${DB_PATHS.API_TOKENS}/${key}`).once('value');
  if (!snap.exists()) return null;

  const userId = snap.val();
  // Best-effort "last used" tracking — not on the critical path, so we
  // don't await it or let a failure here block the actual request.
  ref(`${DB_PATHS.USERS}/${userId}/apiToken/lastUsedAt`).set(serverTimestamp()).catch(() => {});
  return userId;
}

module.exports = {
  getOrCreateToken,
  regenerateToken,
  resolveToken,
};

},

// ===== services/merchantPromoService.js =====
"services/merchantPromoService.js": function (module, exports, __r) {
// services/merchantPromoService.js
// Promo codes a MERCHANT creates for THEIR OWN customers (Management → Promo Codes).
// Not to be confused with services/promoService.js, which is the platform's
// wallet-credit promo system run by the admin.
//
//   merchantPromos/{ownerUid}/{CODE}                          → the promo
//   merchantPromoRedemptions/{ownerUid}/{CODE}/{orderId}      → one entry per PAID redemption
//
// How a customer uses one: on the merchant's checkout page they tap "Have a
// promo code?", enter it, and the order's payable amount drops. The amount is
// changed on the payment record itself (the same record every verifier —
// FamPay / Paytm / Amazon — reads), so the customer pays the discounted
// amount and verification matches it.
//
// Usage counting (maxUses): applying a code puts a short-lived HOLD on it.
// A hold becomes a real use only when the order is actually paid
// (reconcile()); holds of failed / cancelled / abandoned orders expire
// on their own. So an abandoned checkout never burns a code.
const crypto = require('crypto');
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");

const MAX_PROMOS_PER_MERCHANT = 50;
const HOLD_TTL_MS = 20 * 60 * 1000;
const MAX_FAILED_ATTEMPTS_PER_ORDER = 8;
const CODE_RE = /^[A-Z0-9]{4,20}$/;
const MAX_PERCENT = 90;
const MAX_FIXED = 100000;

class PromoError extends Error {
  constructor(message, status = 400, extra = null) {
    super(message);
    this.name = 'PromoError';
    this.status = status;
    this.extra = extra;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const rs = (n) => '₹' + (Number.isInteger(round2(n)) ? round2(n) : round2(n).toFixed(2));
const normalizeCode = (c) => String(c == null ? '' : c).trim().toUpperCase().replace(/\s+/g, '');

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read out loud
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/* ───────────── validation ───────────── */
function num(value, label, { min, max, integer = false, allowEmpty = false }) {
  if (value === undefined || value === null || value === '') {
    if (allowEmpty) return null;
    throw new PromoError(`${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new PromoError(`${label} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new PromoError(`${label} must be a whole number.`);
  if (min !== undefined && n < min) throw new PromoError(`${label} must be at least ${min}.`);
  if (max !== undefined && n > max) throw new PromoError(`${label} must be at most ${max}.`);
  return round2(n);
}

/** Validates + normalizes the editable fields. `base` supplies values for fields not in `input` (edit case). */
function cleanFields(input, base = {}) {
  const out = {};
  const type = input.type !== undefined ? input.type : base.type;
  if (type !== 'percent' && type !== 'fixed') throw new PromoError('Choose a discount type: percentage or fixed amount.');
  out.type = type;

  const rawValue = input.value !== undefined ? input.value : base.value;
  out.value = type === 'percent'
    ? num(rawValue, 'Discount percentage', { min: 1, max: MAX_PERCENT })
    : num(rawValue, 'Discount amount', { min: 1, max: MAX_FIXED });

  const rawMin = input.minOrder !== undefined ? input.minOrder : base.minOrder;
  out.minOrder = num(rawMin === undefined ? 0 : rawMin, 'Minimum order amount', { min: 0, max: 10000000, allowEmpty: true }) || 0;

  const rawCap = input.maxDiscount !== undefined ? input.maxDiscount : base.maxDiscount;
  out.maxDiscount = type === 'percent' ? num(rawCap, 'Maximum discount', { min: 1, max: 10000000, allowEmpty: true }) : null;

  const rawUses = input.maxUses !== undefined ? input.maxUses : base.maxUses;
  if (rawUses === undefined || rawUses === null || rawUses === '' || Number(rawUses) <= 0) out.maxUses = -1; // unlimited
  else out.maxUses = num(rawUses, 'Usage limit', { min: 1, max: 1000000, integer: true });

  const rawExp = input.expiresAt !== undefined ? input.expiresAt : base.expiresAt;
  if (rawExp === undefined || rawExp === null || rawExp === '' || rawExp === 0) out.expiresAt = null;
  else {
    const t = Number(rawExp);
    if (!Number.isFinite(t) || t <= 0) throw new PromoError('Expiry date is not valid.');
    if (t <= Date.now()) throw new PromoError('Expiry date must be in the future.');
    out.expiresAt = Math.round(t);
  }

  if (type === 'fixed' && out.minOrder > 0 && out.value >= out.minOrder) {
    throw new PromoError(`A flat discount of ${rs(out.value)} must be smaller than the minimum order amount (${rs(out.minOrder)}).`);
  }

  const rawNote = input.note !== undefined ? input.note : base.note;
  const note = String(rawNote == null ? '' : rawNote).replace(/\s+/g, ' ').trim();
  if (note.length > 80) throw new PromoError('Note must be at most 80 characters.');
  out.note = note;
  return out;
}

/* ───────────── discount math (shared by apply + preview) ───────────── */
function computeDiscount(promo, orderAmount) {
  const amount = round2(orderAmount);
  const effectiveMin = Math.max(promo.minOrder || 0, promo.type === 'fixed' ? promo.value + 1 : 2);
  if (amount < effectiveMin) {
    return { ok: false, minimum: effectiveMin };
  }
  let discount = promo.type === 'percent' ? round2(amount * promo.value / 100) : promo.value;
  if (promo.type === 'percent' && promo.maxDiscount) discount = Math.min(discount, promo.maxDiscount);
  discount = Math.min(discount, round2(amount - 1)); // UPI cannot collect less than ₹1
  return { ok: true, discount: round2(discount), finalAmount: round2(amount - discount) };
}

/* ───────────── owner: CRUD ───────────── */
async function loadPromos(ownerUid) {
  const snap = await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}`).once('value');
  return snap.exists() ? Object.values(snap.val()) : [];
}

function publicPromo(p) {
  const holds = p.holds ? Object.keys(p.holds).length : 0;
  return {
    code: p.code, type: p.type, value: p.value, minOrder: p.minOrder || 0,
    maxDiscount: p.maxDiscount || null, maxUses: p.maxUses === undefined ? -1 : p.maxUses,
    used: p.used || 0, discountGiven: round2(p.discountGiven || 0), pending: holds,
    isActive: !!p.isActive, adminLocked: !!p.adminLocked, expiresAt: p.expiresAt || null, note: p.note || '',
    createdAt: p.createdAt || null, updatedAt: p.updatedAt || null, createdBy: p.createdBy || '',
    expired: !!(p.expiresAt && Date.now() > p.expiresAt),
  };
}

async function listPromos(ownerUid) {
  let promos = await loadPromos(ownerUid);
  // Settle any holds first so the numbers shown are real.
  const withHolds = promos.filter((p) => p.holds && Object.keys(p.holds).length);
  if (withHolds.length) {
    await Promise.all(withHolds.map((p) => reconcile(ownerUid, p.code).catch((e) => logger.warn(`promo reconcile ${p.code}: ${e.message}`))));
    promos = await loadPromos(ownerUid);
  }
  promos.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return promos.map(publicPromo);
}

async function createPromo(ownerUid, input, actor) {
  const fields = cleanFields(input || {});
  let code = normalizeCode(input.code);
  if (code && !CODE_RE.test(code)) throw new PromoError('Promo code must be 4–20 characters: letters and numbers only.', 400, { field: 'code' });

  const existing = await loadPromos(ownerUid);
  if (existing.length >= MAX_PROMOS_PER_MERCHANT) {
    throw new PromoError(`You can have up to ${MAX_PROMOS_PER_MERCHANT} promo codes. Delete one you no longer need.`, 403);
  }
  const now = Date.now();
  const build = (c) => ({
    code: c, ...fields, used: 0, discountGiven: 0, isActive: true,
    createdAt: now, updatedAt: now, createdBy: actor || 'owner',
  });

  // Auto-generated code: retry a few times on the (very unlikely) clash.
  const attempts = code ? 1 : 5;
  for (let i = 0; i < attempts; i++) {
    const candidate = code || generateCode();
    const record = build(candidate);
    const tx = await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${candidate}`).transaction((cur) => (cur ? undefined : record));
    if (tx.committed) return publicPromo(record);
    if (code) throw new PromoError(`You already have a promo code named ${code}. Choose a different name.`, 409, { field: 'code' });
  }
  throw new PromoError('Could not generate a unique code. Please try again.', 500);
}

async function getOwned(ownerUid, codeInput) {
  const code = normalizeCode(codeInput);
  const snap = await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}`).once('value');
  if (!snap.exists()) throw new PromoError('Promo code not found.', 404);
  return snap.val();
}

async function updatePromo(ownerUid, codeInput, input) {
  const cur = await getOwned(ownerUid, codeInput);
  const patch = {};
  const touchesRules = ['type', 'value', 'minOrder', 'maxDiscount', 'maxUses', 'expiresAt', 'note'].some((k) => input[k] !== undefined);
  if (touchesRules) Object.assign(patch, cleanFields(input, cur));
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') throw new PromoError('Invalid status.');
    if (input.isActive === true && cur.adminLocked) {
      throw new PromoError('This promo code was disabled by ZapPay support and cannot be re-enabled. Contact support.', 403);
    }
    patch.isActive = input.isActive;
  }
  if (!Object.keys(patch).length) throw new PromoError('Nothing to update.');
  // An expired code that is being edited to a past date is rejected in cleanFields;
  // editing OTHER fields of an already-expired code must keep its old expiry.
  if (!touchesRules || input.expiresAt === undefined) delete patch.expiresAt;
  patch.updatedAt = Date.now();
  await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${cur.code}`).update(patch);
  return publicPromo({ ...cur, ...patch });
}

async function deletePromo(ownerUid, codeInput) {
  const cur = await getOwned(ownerUid, codeInput);
  await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${cur.code}`).remove();
  // Redemption history stays (it is the merchant's record of past discounts).
}

async function listRedemptions(ownerUid, codeInput, limit = 30) {
  const code = normalizeCode(codeInput);
  await reconcile(ownerUid, code).catch(() => {});
  const snap = await ref(`${DB_PATHS.MERCHANT_PROMO_REDEMPTIONS}/${ownerUid}/${code}`).once('value');
  const rows = snap.exists() ? Object.values(snap.val()) : [];
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/* ───────────── usage settlement ───────────── */
async function reconcile(ownerUid, code) {
  const pRef = ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}`);
  const snap = await pRef.once('value');
  if (!snap.exists()) return null;
  const promo = snap.val();
  const holds = promo.holds || {};
  const entries = Object.entries(holds);
  if (!entries.length) return promo;

  const now = Date.now();
  const paid = [];     // { orderId, discount, original, final }
  const release = [];  // orderIds
  for (const [orderId, h] of entries) {
    const pSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    const pay = pSnap.exists() ? pSnap.val() : null;
    if (pay && pay.status === 'success') paid.push({ orderId, discount: h.discount, original: pay.originalAmount, final: pay.amount });
    else if (pay && (pay.status === 'pending' || pay.status === 'ambiguous') && now - (h.at || 0) <= HOLD_TTL_MS) continue; // still open
    else release.push(orderId); // failed / cancelled / timeout / abandoned / deleted
  }
  if (!paid.length && !release.length) return promo;

  const settleIds = new Set([...paid.map((p) => p.orderId), ...release]);
  const tx = await pRef.transaction((cur) => {
    if (!cur) return cur;
    const curHolds = cur.holds || {};
    let used = cur.used || 0;
    let given = cur.discountGiven || 0;
    for (const p of paid) {
      if (curHolds[p.orderId]) { used += 1; given += p.discount || 0; } // counted once: only if the hold still exists
    }
    settleIds.forEach((id) => { delete curHolds[id]; });
    cur.holds = curHolds;
    cur.used = used;
    cur.discountGiven = round2(given);
    return cur;
  });

  if (tx.committed) {
    await Promise.all(paid.map((p) => ref(`${DB_PATHS.MERCHANT_PROMO_REDEMPTIONS}/${ownerUid}/${code}/${p.orderId}`).set({
      orderId: p.orderId, originalAmount: p.original || null, discount: p.discount, finalAmount: p.final || null, at: Date.now(),
    }).catch(() => {})));
  }
  const after = await pRef.once('value');
  return after.exists() ? after.val() : null;
}

/* ───────────── customer-facing (public) ───────────── */
function orderSupport(payment) {
  if (!payment) return { supported: false, reason: 'Order not found.' };
  if (!(payment.type === 'api' || payment.linkId)) return { supported: false, reason: 'Promo codes cannot be used on this payment.' };
  // 'wallet' orders were created at the ZapUPI gateway with a fixed amount — it can't be changed afterwards.
  if (!payment.isTest && (payment.routingEngine === 'wallet' || payment.paymentMethod === 'zapupi')) {
    return { supported: false, reason: 'Promo codes are not available on this checkout.' };
  }
  return { supported: true };
}

const appliedView = (payment) => (payment.promoCode ? {
  code: payment.promoCode,
  original_amount: payment.originalAmount,
  discount: payment.promoDiscount,
  final_amount: payment.amount,
} : null);

/** Extra fields merchants get in order-status responses and webhooks when a promo was used. */
function orderPromoFields(payment) {
  if (!payment || !payment.promoCode) return {};
  return { promo_code: payment.promoCode, original_amount: payment.originalAmount, discount: payment.promoDiscount };
}

async function getPayment(orderId) {
  const snap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function orderInfo(orderId) {
  const payment = await getPayment(String(orderId || ''));
  const support = orderSupport(payment);
  if (!payment) throw new PromoError('Order not found.', 404);
  if (!support.supported || payment.status !== 'pending') {
    return { available: false, applied: appliedView(payment), amount: payment.amount };
  }
  const promos = await loadPromos(payment.userId);
  const now = Date.now();
  const hasPromos = promos.some((p) => p.isActive && (!p.expiresAt || p.expiresAt > now));
  return { available: hasPromos || !!payment.promoCode, applied: appliedView(payment), amount: payment.amount };
}

async function bumpFail(orderId) {
  await ref(`${DB_PATHS.PAYMENTS}/${orderId}/promoFailCount`).transaction((c) => (c || 0) + 1).catch(() => {});
}

async function applyToOrder(orderId, codeInput) {
  orderId = String(orderId || '');
  const code = normalizeCode(codeInput);
  if (!code) throw new PromoError('Please enter a promo code.', 400, { field: 'code' });
  if (!orderId) throw new PromoError('Order not found.', 404);

  const payment = await getPayment(orderId);
  const support = orderSupport(payment);
  if (!payment) throw new PromoError('Order not found.', 404);
  if (!support.supported) throw new PromoError(support.reason, 400);
  if (payment.status !== 'pending') throw new PromoError('This order is no longer open for payment.', 409);
  if ((payment.promoFailCount || 0) >= MAX_FAILED_ATTEMPTS_PER_ORDER) {
    throw new PromoError('Too many invalid attempts on this checkout. Please start a new payment and try again.', 429);
  }
  if (payment.promoCode) {
    if (payment.promoCode === code) return { applied: appliedView(payment), alreadyApplied: true };
    throw new PromoError(`Promo code ${payment.promoCode} is already applied. Remove it first to use a different code.`, 409);
  }

  const fail = async (message, status = 400, extra = null) => { await bumpFail(orderId); throw new PromoError(message, status, extra); };

  const ownerUid = payment.userId;
  const snap = await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}`).once('value');
  if (!snap.exists()) return fail('This promo code is not valid.', 404, { field: 'code' });
  const promo = snap.val();
  if (!promo.isActive) return fail('This promo code is not active.', 400, { field: 'code' });
  if (promo.expiresAt && Date.now() > promo.expiresAt) return fail('This promo code has expired.', 400, { field: 'code' });

  const original = round2(payment.originalAmount != null ? payment.originalAmount : payment.amount);
  const calc = computeDiscount(promo, original);
  if (!calc.ok) {
    return fail(`This promo code needs an order of at least ${rs(calc.minimum)}. Your order is ${rs(original)}.`, 400, { field: 'code', minOrder: calc.minimum });
  }

  // Settle old holds so "usage limit reached" is judged on real numbers.
  if (promo.maxUses > 0) await reconcile(ownerUid, code).catch(() => {});

  // 1) Take a hold on the code (atomic limit check).
  const pRef = ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}`);
  const now = Date.now();
  const hold = await pRef.transaction((cur) => {
    if (!cur) return cur;
    if (!cur.isActive) return undefined;
    if (cur.expiresAt && now > cur.expiresAt) return undefined;
    const holds = cur.holds || {};
    const live = Object.entries(holds).filter(([id, h]) => id !== orderId && now - (h.at || 0) <= HOLD_TTL_MS).length;
    if (cur.maxUses > 0 && (cur.used || 0) + live >= cur.maxUses) return undefined;
    holds[orderId] = { at: now, discount: calc.discount };
    cur.holds = holds;
    return cur;
  });
  if (!hold.committed || !hold.snapshot.val()) {
    const again = await pRef.once('value');
    const cur = again.exists() ? again.val() : null;
    if (!cur) return fail('This promo code is not valid.', 404, { field: 'code' });
    if (!cur.isActive) return fail('This promo code is not active.', 400, { field: 'code' });
    if (cur.expiresAt && Date.now() > cur.expiresAt) return fail('This promo code has expired.', 400, { field: 'code' });
    return fail('This promo code has reached its usage limit.', 400, { field: 'code' });
  }

  // 2) Lower the order's amount — only if it is STILL pending (the customer
  //    may have paid in the meantime), done atomically on the payment record.
  const pay = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).transaction((cur) => {
    if (!cur) return cur;
    if (cur.status !== 'pending') return undefined;
    if (cur.promoCode) return undefined;
    cur.originalAmount = original;
    cur.amount = calc.finalAmount;
    cur.promoCode = code;
    cur.promoDiscount = calc.discount;
    cur.promoAppliedAt = now;
    return cur;
  });
  if (!pay.committed || !pay.snapshot.val()) {
    await ref(`${DB_PATHS.MERCHANT_PROMOS}/${ownerUid}/${code}/holds/${orderId}`).remove().catch(() => {});
    throw new PromoError('This order is no longer open for payment.', 409);
  }

  logger.info(`Merchant promo applied: order=${orderId} owner=${ownerUid} code=${code} -${calc.discount}`);
  return { applied: { code, original_amount: original, discount: calc.discount, final_amount: calc.finalAmount }, alreadyApplied: false };
}

async function removeFromOrder(orderId) {
  orderId = String(orderId || '');
  const payment = await getPayment(orderId);
  if (!payment) throw new PromoError('Order not found.', 404);
  if (!payment.promoCode) return { removed: false, amount: payment.amount };
  if (payment.status !== 'pending') throw new PromoError('This order is no longer open for payment.', 409);

  const code = payment.promoCode;
  const tx = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).transaction((cur) => {
    if (!cur) return cur;
    if (cur.status !== 'pending') return undefined;
    if (!cur.promoCode) return cur;
    cur.amount = cur.originalAmount;
    cur.originalAmount = null;
    cur.promoCode = null;
    cur.promoDiscount = null;
    cur.promoAppliedAt = null;
    return cur;
  });
  if (!tx.committed) throw new PromoError('This order is no longer open for payment.', 409);

  // Free the hold so the code isn't counted for an order that no longer uses it.
  await ref(`${DB_PATHS.MERCHANT_PROMOS}/${payment.userId}/${code}/holds/${orderId}`).remove().catch(() => {});
  return { removed: true, amount: tx.snapshot.val().amount };
}

module.exports = {
  PromoError, MAX_PROMOS_PER_MERCHANT, normalizeCode, generateCode, computeDiscount,
  listPromos, createPromo, updatePromo, deletePromo, listRedemptions,
  orderInfo, applyToOrder, removeFromOrder, orderPromoFields, reconcile,
};

},

// ===== services/paytmService.js =====
"services/paytmService.js": function (module, exports, __r) {
// services/paytmService.js
//
// Mirrors fampayService.js's verifyPayment shape, but for Paytm. FamPay
// has no official merchant API, so its verifyPayment scrapes a connected
// Gmail inbox (via history.php) and matches transactions by amount/time.
// Paytm DOES have an official order-status API
// (https://securegw.paytm.in/order/status), keyed by MID + the merchant's
// own order/txn reference — so this never touches email at all, and the
// amount/time/dedup heuristics fampayService needs (because it's matching
// blind against an inbox) aren't needed here: Paytm's response is already
// scoped to the exact order being asked about.
const axios = require('axios');
const encryption = __r("utils/encryption.js");
const firebaseService = __r("services/firebaseService.js");
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");

const PAYTM_STATUS_URL = 'https://securegw.paytm.in/order/status';

/**
 * Verifies one pending order against Paytm's own order-status API, using
 * THIS order's own owner's connected MID — never a shared/hardcoded
 * credential, same principle as fampayService's per-user credential
 * sourcing. On a confirmed TXN_SUCCESS (matched to this exact order's own
 * merchantTransactionId, not just amount), updates the order to success
 * and credits the wallet exactly once.
 */
const verifyPayment = async (orderId) => {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment || payment.status !== 'pending') return false;
    if (!payment.paytmTxnRef) return false; // order wasn't created via the Paytm flow

    const verifyUid = payment.paytmVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.paytm || !user.paytm.isConnected) return false;

    const rawMid = encryption.decrypt(user.paytm.mid);
    if (!rawMid) return false;

    const response = await axios.get(PAYTM_STATUS_URL, {
      params: { JsonData: JSON.stringify({ MID: rawMid, ORDERID: payment.paytmTxnRef }) },
      timeout: 8000,
    });

    const data = response.data;
    if (!data || typeof data !== 'object') return false;

    // Paytm's own three-way match: right gateway status, right MID, right
    // order reference. Amount is checked too as a final sanity guard, even
    // though ORDERID alone already scopes this to one specific order.
    const txnAmount = parseFloat(data.TXNAMOUNT);
    const paymentAmount = parseFloat(payment.amount);
    if (
      data.STATUS === 'TXN_SUCCESS' &&
      data.MID === rawMid &&
      data.ORDERID === payment.paytmTxnRef &&
      txnAmount === paymentAmount
    ) {
      const utr = data.BANKTXNID || data.TXNID || '';

      // Same UTR-already-claimed guard as fampayService — closes the
      // race where two orders could otherwise both try to claim the same
      // underlying bank transaction.
      if (utr) {
        const existingCheck = await firebaseService.getPaymentByUtr(utr);
        if (existingCheck && existingCheck.orderId !== orderId) return false;
      }

      // Atomically claim the PENDING->SUCCESS transition first, so two
      // concurrent polls for the same order can't both credit the wallet.
      const updateResult = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`)
        .transaction((current) => {
          if (!current || current.status !== 'pending') return; // abort — already handled by another poll
          current.status = 'success';
          current.utr = utr;
          current.txnId = data.TXNID || utr;
          current.updatedAt = Date.now();
          return current;
        });

      if (!updateResult.committed) return true; // another poll already won the race — still a genuine success, just not ours to re-process

      logger.info(`Paytm Match Found for Order ${orderId}! UTR: ${utr}`);

      const walletService = __r("services/walletService.js");

      // NOTE: unlike FamPay, Paytm has no ZapPay-pooled/system_cashier path —
      // every Paytm order is verified against THIS merchant's own connected
      // MID (line 39 above), meaning the money always already lands directly
      // in the merchant's own Paytm account. Crediting it again to the
      // ZapPay wallet would be a duplicate the merchant could then withdraw
      // on top of money they already have — the same double-payout risk as
      // genuine 'cashier' routing in fampayService.js. So Paytm orders never
      // credit Zap Cash; only the Zap Credit commission below applies.
      // incrementLinkUsage is a usage-count record, not money movement, so
      // it's unaffected and still only runs for the system_cashier case
      // (kept for forward-compatibility if a pooled Paytm path is ever added).
      if (payment.routingEngine === 'system_cashier') {
        try {
          const subscriptionService = __r("services/subscriptionService.js");
          await subscriptionService.incrementLinkUsage(payment.userId);
        } catch (e) {
          logger.error(`Failed to increment link usage for ${orderId}: ${e.message}`);
        }
      }

      // ─── Zap Credit deduction (unconditional) ─────────────────────
      // Same as fampayService/smsWebhookController: commission is owed
      // on every successful order regardless of routing engine. Never
      // blocks the payment — a failed debit is logged, not thrown.
      try {
        const subscriptionService = __r("services/subscriptionService.js");
        const sub = await subscriptionService.getUserSubscription(payment.userId);
        const plan = sub.plan;
        const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
        const creditCost = Math.round((paymentAmount * commissionPct) / 100 * 100) / 100;
        if (creditCost > 0) {
          try {
            await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
          } catch (e) {
            logger.error(`Zap Credit debit failed for Paytm order ${orderId}: ${e.message}`);
          }
        }
      } catch (e) {
        logger.error(`Commission calc failed for Paytm order ${orderId}: ${e.message}`);
      }

      try {
        const webhookService = __r("services/webhookService.js");
        await webhookService.notifyUserWebhooks(payment.userId, 'payment.success', {
          order_id: orderId, status: 'success', amount: paymentAmount, utr, method: 'paytm',
        });
      } catch (e) { /* webhook delivery failures shouldn't block verification */ }

      try {
        const notificationService = __r("services/notificationService.js");
        const title = 'Payment Received';
        const message = `₹${paymentAmount} received via Paytm for order ${orderId}.`;
        await notificationService.createNotification(payment.userId, { title, message, type: 'payment' });
      } catch (e) { /* notification failures shouldn't block verification */ }

      return true;
    }

    if (data.STATUS === 'TXN_FAILURE' || data.STATUS === 'PENDING') {
      return false; // caller keeps polling — not yet a terminal state worth acting on
    }

    return false;
  } catch (err) {
    logger.error(`Paytm verifyPayment error for ${orderId}: ${err.message}`);
    return false;
  }
};

module.exports = { verifyPayment };

},

// ===== controllers/webhookController.js =====
"controllers/webhookController.js": function (module, exports, __r) {
// controllers/webhookController.js
// Dashboard-authenticated (JWT) endpoints for a merchant to manage their
// own outgoing webhook URLs — see services/webhookService.js for what
// these are actually used for (order.pending / order.success / order.failed
// notifications sent to the merchant's own server).
const { body, validationResult } = require('express-validator');
const webhookService = __r("services/webhookService.js");
const subscriptionService = __r("services/subscriptionService.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * GET /api/developer/webhooks
 * Returns the merchant's registered webhook URLs plus their plan's limit,
 * so the Developer Portal can show "3 / 5 used" and disable the add button
 * at the cap.
 */
const listWebhooks = async (req, res) => {
  try {
    const [webhooks, sub] = await Promise.all([
      webhookService.listWebhooks(req.user.uid),
      subscriptionService.getUserSubscription(req.user.uid),
    ]);
    const limit = webhookService.getLimitForPlan(sub.plan);
    return response.success(res, 'Webhooks fetched', {
      webhooks,
      limit, // -1 means unlimited
      planName: sub.plan.name,
    });
  } catch (err) {
    logger.error('listWebhooks error: ' + err.message);
    return response.serverError(res, err.message);
  }
};

const addWebhookValidation = [
  body('url').notEmpty().withMessage('Webhook URL is required').trim(),
];

/**
 * POST /api/developer/webhooks
 * Body: { url }
 */
const addWebhook = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const webhook = await webhookService.addWebhook(req.user.uid, req.body.url);
    await firebaseService.logActivity(req.user.uid, 'WEBHOOK_ADDED', { url: webhook.url });
    return response.success(res, 'Webhook added', { webhook });
  } catch (err) {
    // addWebhook throws plain, user-facing Error messages (limit reached,
    // invalid URL, duplicate) — surface those directly rather than a
    // generic 500, same pattern the rest of this codebase uses.
    return response.error(res, err.message || 'Failed to add webhook');
  }
};

/**
 * DELETE /api/developer/webhooks/:webhookId
 */
const deleteWebhook = async (req, res) => {
  try {
    await webhookService.deleteWebhook(req.user.uid, req.params.webhookId);
    await firebaseService.logActivity(req.user.uid, 'WEBHOOK_DELETED', { webhookId: req.params.webhookId });
    return response.success(res, 'Webhook removed');
  } catch (err) {
    return response.error(res, err.message || 'Failed to remove webhook');
  }
};

/**
 * PUT /api/developer/webhooks/:webhookId/toggle
 * Body: { isActive }
 */
const toggleWebhook = async (req, res) => {
  try {
    const isActive = !!req.body.isActive;
    await webhookService.toggleWebhook(req.user.uid, req.params.webhookId, isActive);
    return response.success(res, isActive ? 'Webhook enabled' : 'Webhook disabled');
  } catch (err) {
    return response.error(res, err.message || 'Failed to update webhook');
  }
};

module.exports = {
  listWebhooks,
  addWebhookValidation,
  addWebhook,
  deleteWebhook,
  toggleWebhook,
};

},

// ===== middleware/apiKeyAuth.js =====
"middleware/apiKeyAuth.js": function (module, exports, __r) {
// middleware/apiKeyAuth.js - ZapAPI Key Authentication Middleware
//
// Authenticates requests made by a MERCHANT'S OWN site/app/server using
// their ZapPay-issued "ZapAPI" key (see services/apiTokenService.js).
// Accepts the key either in the request body (`zap_api`) or in the
// `X-ZapAPI-Key` header — matching the same lookup order `apiKeyLimiter`
// uses in middleware/rateLimiter.js, so the rate-limit bucket and the
// auth check always agree on which key made the call.
//
// NOTE: this file was missing from the deployed code entirely. Since
// routes/developer.js requires it at the top of the file (not lazily,
// inside a route handler), Node threw "Cannot find module
// '../middleware/apiKeyAuth'" while loading server.js itself — which
// crashes EVERY request through the app (server.js is the single
// serverless function all routes are routed to), not just /api/developer
// calls. That's why /api/config, /api/auth, etc. were all returning 500.
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const apiTokenService = __r("services/apiTokenService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = (req.body && req.body.zap_api) || req.headers['x-zapapi-key'];

    if (!apiKey) {
      return response.unauthorized(
        res,
        'Missing ZapAPI key. Pass it as "zap_api" in the request body or an "X-ZapAPI-Key" header.'
      );
    }

    const userId = await apiTokenService.resolveToken(apiKey);
    if (!userId) {
      return response.unauthorized(res, 'Invalid ZapAPI key');
    }

    // Same "still exists / not banned" check `authenticate` does for
    // JWT-based dashboard sessions — a banned merchant shouldn't be able
    // to keep creating orders through their own site just because they
    // never rotated their ZapAPI key.
    const userSnap = await ref(`${DB_PATHS.USERS}/${userId}`).once('value');
    if (!userSnap.exists()) {
      return response.unauthorized(res, 'User not found');
    }

    const user = userSnap.val();
    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'This account has been suspended.',
        banned: true,
      });
    }

    req.user = { uid: userId };
    next();
  } catch (err) {
    logger.error('ZapAPI key auth error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = { authenticateApiKey };

},

// ===== routes/gatewayTest.js =====
"routes/gatewayTest.js": function (module, exports, __r) {
// routes/gatewayTest.js - Gateway Test Mode simulator (backs test.html)
//
// Public, unauthenticated — same pattern as routes/paymentLink.js's public
// endpoints. Every handler is scoped to isTest === true orders only, so
// there's nothing sensitive-by-guessing-an-orderId here beyond what
// pay.html already exposes for any order (amount/title/merchant name).
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/gatewayTestController.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

router.get('/:orderId', ctrl.getTestOrder);
router.post('/:orderId/simulate', paymentLimiter, ctrl.simulateResult);

module.exports = router;

},

// ===== controllers/gatewayTestController.js =====
"controllers/gatewayTestController.js": function (module, exports, __r) {
// controllers/gatewayTestController.js - Gateway Test Mode simulator
//
// Backs test.html. When a merchant has switched their account to Test
// Mode, developerController.createOrder and paymentLinkController's
// initiatePayment both hand the customer a payment_url that points here
// instead of to the real Zap UPI Gateway. Nothing in this file ever calls
// walletService — a test order can only ever change a payment's `status`
// and send a clearly-labelled notification, never move real money.
//
// Both endpoints are public/unauthenticated by design, same as
// getLinkPublic/getLinkOrderStatus — the person hitting test.html is a
// merchant's own customer (or the merchant themselves while integrating),
// never a logged-in ZapPay dashboard user. Safety instead comes from
// scoping: every lookup below requires payment.isTest === true, so this
// code can never read or touch a real, live order no matter what orderId
// is passed in.
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS, NOTIFICATION_TYPE } = __r("config/constants.js");
const firebaseService = __r("services/firebaseService.js");
const notificationService = __r("services/notificationService.js");
const gatewayModeService = __r("services/gatewayModeService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

/**
 * Where test.html should send the customer after an outcome is chosen.
 * Mirrors exactly where a REAL Zap Gateway redirect would have sent them
 * for the same order, so nothing downstream needs to know it was a test.
 */
function buildRedirectUrl(payment, result) {
  const FRONTEND = gatewayModeService.getFrontendBase();

  // Payment-link order -> same verification round trip a real link
  // payment uses (pay.html re-checks status server-side before showing
  // success/failure, so this is safe even though the redirect itself is
  // just a query param set by the client).
  if (payment.linkId) {
    return `${FRONTEND}/pay.html?id=${payment.linkId}&order=${payment.orderId}&result=${result}`;
  }

  // Store Portal purchase -> back to the SAME storefront page the
  // customer bought from (root/store/index.html, YOUR-DOMAIN.com/store=<id>),
  // not pay.html or the merchant dashboard — it re-verifies via
  // getOrderStatus itself before showing the product's delivery link,
  // same safety principle as the pay.html path. Lives on the root domain,
  // not the panel FRONTEND base, so it gets its own base URL.
  if (payment.storeId) {
    const STORE_BASE = gatewayModeService.getStoreBase();
    return `${STORE_BASE}/store=${payment.storeId}?order=${payment.orderId}&result=${result}`;
  }

  // ZapAPI order where the merchant supplied their own redirect_url ->
  // send them back there with the same zp_order/zp_result params a real
  // Zap Gateway redirect would use.
  if (payment.testRedirectUrl) {
    const sep = payment.testRedirectUrl.includes('?') ? '&' : '?';
    return `${payment.testRedirectUrl}${sep}zp_order=${payment.orderId}&zp_result=${result}`;
  }

  // ZapAPI order opened via the zappay-pay.js widget popup -> no redirect
  // at all. The widget is already polling order-status and will close its
  // own popup the moment it sees the new status.
  if (payment.testUseEmbedded) {
    return null;
  }

  // Raw ZapAPI call with no redirect_url given — same fallback
  // zapService.js itself uses for a live order in this situation.
  return `${FRONTEND}/index.html?payment=${result}&order=${payment.orderId}`;
}

/** Clearly-labelled Test Mode notification copy for each outcome. */
function buildNotification(payment, result) {
  const amountStr = `₹${Number(payment.amount).toFixed(2)}`;
  const via = payment.storeId ? 'store' : (payment.linkId ? 'payment link' : 'ZapAPI');

  if (result === 'success') {
    return {
      title: '🧪 Test Payment Successful',
      message: `A ${amountStr} test payment was simulated via your ${via} (Order ${payment.orderId}). Test Mode — your wallet was NOT credited.`,
    };
  }
  if (result === 'cancelled') {
    return {
      title: '🧪 Test Payment Cancelled',
      message: `A ${amountStr} test payment via your ${via} was marked Cancelled (Order ${payment.orderId}). Test Mode — no money was involved.`,
    };
  }
  return {
    title: '🧪 Test Payment Failed',
    message: `A ${amountStr} test payment via your ${via} was marked Failed (Order ${payment.orderId}). Test Mode — no money was involved.`,
  };
}

/**
 * GET /api/gateway-test/:orderId
 * Public. Lets test.html render the order it's simulating a checkout for.
 */
const getTestOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);

    if (!payment || !payment.isTest) {
      return response.notFound(res, 'Test order not found. It may have expired or this link was already used.');
    }

    let merchantName = 'ZapPay Merchant';
    if (payment.linkId) {
      const linkSnap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${payment.linkId}`).once('value');
      if (linkSnap.exists() && linkSnap.val().merchantName) merchantName = linkSnap.val().merchantName;
    } else {
      const merchant = await firebaseService.getUser(payment.userId);
      if (merchant && merchant.displayName) merchantName = merchant.displayName;
    }

    return response.success(res, 'Test order fetched', {
      orderId,
      amount: payment.amount,
      title: payment.remark || 'ZapPay Payment',
      merchantName,
      status: payment.status, // 'pending' | 'success' | 'failed'
      testResult: payment.testResult || null,
    });
  } catch (err) {
    logger.error('Get test order error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/gateway-test/:orderId/simulate
 * Public. Body: { result: 'success' | 'failed' | 'cancelled' }
 *
 * The only three things this ever does: (1) update this ONE payment's
 * status, (2) send one clearly-labelled Test Mode notification to the
 * merchant, (3) hand back where test.html should send the customer next.
 * It never calls walletService, never touches commission/referral/
 * subscription logic, and is a no-op (idempotent) once an order has
 * already left 'pending'.
 */
const simulateResult = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { result } = req.body;

    if (!['success', 'failed', 'cancelled'].includes(result)) {
      return response.error(res, "result must be 'success', 'failed', or 'cancelled'");
    }

    const payment = await firebaseService.getPayment(orderId);
    if (!payment || !payment.isTest) {
      return response.notFound(res, 'Test order not found. It may have expired or this link was already used.');
    }

    // Idempotent: a refreshed tab or an accidental double-tap gets back the
    // same redirect instead of a second notification/activity-log entry.
    if (payment.status !== 'pending') {
      return response.success(res, 'Test result already recorded', {
        redirectUrl: buildRedirectUrl(payment, payment.testResult || payment.status),
      });
    }

    const normalizedStatus = result === 'success' ? 'success' : 'failed';

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: normalizedStatus,
      testResult: result,
      environment: 'test',
      updatedAt: serverTimestamp(),
    });

    const { title, message } = buildNotification(payment, result);
    await notificationService.createNotification(payment.userId, {
      title,
      message,
      type: NOTIFICATION_TYPE.PAYMENT,
    });

    await firebaseService.logActivity(payment.userId, 'test_payment_simulated', {
      orderId,
      result,
      amount: payment.amount,
    });

    logger.info(`[TEST MODE] Order ${orderId} simulated as '${result}'`);

    return response.success(res, 'Test result recorded', {
      redirectUrl: buildRedirectUrl(payment, result),
    });
  } catch (err) {
    logger.error('Simulate test result error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getTestOrder,
  simulateResult,
};

},

// ===== routes/store.js =====
"routes/store.js": function (module, exports, __r) {
// routes/store.js - Store Portal (merchant-facing, JWT auth)
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/storeController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

router.use(authenticate, blockIfBanned);

router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);

router.get('/products', ctrl.getProducts);
router.post('/products', paymentLimiter, ctrl.createProduct);
router.put('/products/:id', ctrl.updateProduct);
router.delete('/products/:id', ctrl.deleteProduct);

router.get('/access', ctrl.getAccess);
router.post('/unlock/upi', paymentLimiter, ctrl.initiateUnlockUpi);
router.post('/unlock/wallet', paymentLimiter, ctrl.unlockViaWallet);

module.exports = router;

},

// ===== controllers/storeController.js =====
"controllers/storeController.js": function (module, exports, __r) {
// controllers/storeController.js - Store Portal (merchant-facing, JWT auth)
// Everything here is scoped to req.user.uid — a merchant can only ever
// read/write their OWN store settings and products through these routes.
// The public storefront (store.html) talks to storePublicController
// instead, which is read-only plus the purchase flow.
const storeService = __r("services/storeService.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const subscriptionService = __r("services/subscriptionService.js");
const zapService = __r("services/zapService.js");
const gatewayModeService = __r("services/gatewayModeService.js");
const notificationService = __r("services/notificationService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const { buildCheckoutUrl } = __r("utils/checkoutUrlBuilder.js");

// One-time fee to unlock Customize Store + Store Settings for anyone not
// on a plan that already includes it for free (see FREE_ACCESS_PLAN_IDS).
// Fixed here, server-side, on purpose — never trust a client-sent amount
// for this, same principle subscriptionController already follows for
// plan prices.
const STORE_UNLOCK_PRICE = 29;
const FREE_ACCESS_PLAN_IDS = ['gold', 'developer'];

/**
 * True if this merchant can use Customize Store / Store Settings right
 * now — either their current plan includes it for free, or they've paid
 * the one-time unlock fee before. My Store (product management) is never
 * gated by this; only the other two Store Portal pages are.
 */
async function hasStoreAccess(uid) {
  const sub = await subscriptionService.getUserSubscription(uid);
  if (FREE_ACCESS_PLAN_IDS.includes(sub?.plan?.id)) return true;
  const settings = await storeService.getOrCreateSettings(uid);
  return !!settings.unlocked;
}

/** GET /api/store/settings */
const getSettings = async (req, res) => {
  try {
    const settings = await storeService.getOrCreateSettings(req.user.uid);
    return response.success(res, 'Store settings fetched', settings);
  } catch (err) {
    logger.error('Get store settings error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/store/settings
 * Body: { storeName?, logoUrl?, theme?, socialLinks?: {telegram,whatsapp,youtube,instagram} }
 * Every field optional — only what's sent gets changed.
 */
const updateSettings = async (req, res) => {
  try {
    const settings = await storeService.updateSettings(req.user.uid, req.body || {});
    await firebaseService.logActivity(req.user.uid, 'store_settings_updated', {});
    return response.success(res, 'Store settings updated', settings);
  } catch (err) {
    logger.error('Update store settings error:', err.message);
    return response.error(res, err.message);
  }
};

/** GET /api/store/products */
const getProducts = async (req, res) => {
  try {
    const products = await storeService.getProducts(req.user.uid);
    return response.success(res, 'Products fetched', { products });
  } catch (err) {
    logger.error('Get products error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/store/products
 * Body: { imageUrl, title, description, originalPrice,        <- required
 *         discountPrice?, productLink?, screenshotUrls?[≤8] }  <- optional
 */
const createProduct = async (req, res) => {
  try {
    const product = await storeService.createProduct(req.user.uid, req.body || {});
    await firebaseService.logActivity(req.user.uid, 'store_product_created', { productId: product.id, title: product.title });
    return response.success(res, 'Product added', product, 201);
  } catch (err) {
    logger.error('Create product error:', err.message);
    return response.error(res, err.message, 400, err.validationErrors || null);
  }
};

/** PUT /api/store/products/:id — every field optional, only what's sent changes */
const updateProduct = async (req, res) => {
  try {
    const product = await storeService.updateProduct(req.user.uid, req.params.id, req.body || {});
    await firebaseService.logActivity(req.user.uid, 'store_product_updated', { productId: req.params.id });
    return response.success(res, 'Product updated', product);
  } catch (err) {
    logger.error('Update product error:', err.message);
    if (err.notFound) return response.notFound(res, 'Product not found');
    return response.error(res, err.message, 400, err.validationErrors || null);
  }
};

/** DELETE /api/store/products/:id */
const deleteProduct = async (req, res) => {
  try {
    await storeService.deleteProduct(req.user.uid, req.params.id);
    await firebaseService.logActivity(req.user.uid, 'store_product_deleted', { productId: req.params.id });
    return response.success(res, 'Product deleted');
  } catch (err) {
    logger.error('Delete product error:', err.message);
    if (err.notFound) return response.notFound(res, 'Product not found');
    return response.serverError(res, err.message);
  }
};

/** GET /api/store/access */
const getAccess = async (req, res) => {
  try {
    const hasAccess = await hasStoreAccess(req.user.uid);
    return response.success(res, 'Access checked', { hasAccess, unlockPrice: STORE_UNLOCK_PRICE });
  } catch (err) {
    logger.error('Get store access error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/store/unlock/upi
 * Creates a real Zap UPI order for the flat unlock fee. Deliberately
 * ALWAYS real money regardless of the merchant's own Gateway Mode — that
 * toggle exists to sandbox COLLECTING FROM customers, not to let a
 * merchant fake-pay their own platform fee, same reasoning
 * subscription/wallet-topup purchases already follow.
 */
const initiateUnlockUpi = async (req, res) => {
  try {
    const uid = req.user.uid;
    if (await hasStoreAccess(uid)) return response.error(res, 'Your store is already unlocked.');

    const orderId = zapService.generateOrderId(uid);
    const settings = await firebaseService.getSettings();
    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, {
      userId: uid,
      amount: STORE_UNLOCK_PRICE,
      remark: 'ZapPay Store Unlock (One-Time)',
      type: 'store_unlock',
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    // Land back on Store Portal specifically (not the generic dashboard
    // default) with a flag index.html's own JS checks for on load to
    // show the same premium unlock celebration the wallet-pay path shows
    // immediately — the webhook will have already confirmed and unlocked
    // by the time a real UPI redirect completes.
    const DASH = gatewayModeService.getFrontendBase();

    if (isSystemCashier) {
        const safeRedirect = `${DASH}/index.html?storeUnlock=success&order=${orderId}`;
        // Checkout customization comes from sysAdminUser, not the merchant
        // unlocking store access — same reasoning as elsewhere: the admin's
        // FamPay is what's actually collecting this payment.
        const checkoutUrl = buildCheckoutUrl(sysAdminUser, { orderId, amount: STORE_UNLOCK_PRICE, upiId: sysAdminUser.fampay.upiId, redirectUrl: safeRedirect, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
        logger.info(`Store unlock order created (System Cashier): ${orderId}`);
        return response.success(res, 'Payment order created', {
            orderId: orderId,
            paymentUrl: checkoutUrl,
            amount: STORE_UNLOCK_PRICE,
        });
    }

    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(STORE_UNLOCK_PRICE.toFixed(2)),
      remark: 'ZapPay Store Unlock',
      successUrl: `${DASH}/index.html?storeUnlock=success&order=${orderId}`,
      failedUrl:  `${DASH}/index.html?storeUnlock=failed&order=${orderId}`,
      timeoutUrl: `${DASH}/index.html?storeUnlock=failed&order=${orderId}`,
    });

    logger.info(`Store unlock order created: ${orderId} by user ${uid}`);
    return response.success(res, 'Payment order created', {
      orderId: zapOrder.orderId,
      paymentUrl: zapOrder.paymentUrl,
      amount: STORE_UNLOCK_PRICE,
    });
  } catch (err) {
    logger.error('Initiate store unlock (UPI) error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/store/unlock/wallet
 * Instant unlock straight from wallet balance — same "debit now, mark
 * order Success immediately, no webhook needed" pattern
 * purchasePlanWithWallet already uses for plan upgrades.
 */
const unlockViaWallet = async (req, res) => {
  try {
    const uid = req.user.uid;
    if (await hasStoreAccess(uid)) return response.error(res, 'Your store is already unlocked.');

    const balance = await walletService.getBalance(uid);
    if (balance < STORE_UNLOCK_PRICE) {
      return response.error(res, `Insufficient wallet balance. You need ₹${STORE_UNLOCK_PRICE}, available: ₹${balance.toFixed(2)}`);
    }

    try {
      await walletService.debitWallet(uid, STORE_UNLOCK_PRICE, 'Store Unlock (One-Time)');
    } catch (debitErr) {
      if (debitErr.message === 'INSUFFICIENT_BALANCE') return response.error(res, 'Insufficient wallet balance.');
      throw debitErr;
    }

    await storeService.setUnlocked(uid, true);

    const orderId = zapService.generateOrderId(uid);
    await firebaseService.createPayment(orderId, {
      userId: uid,
      amount: STORE_UNLOCK_PRICE,
      remark: 'ZapPay Store Unlock (Wallet)',
      type: 'store_unlock',
    });
    await firebaseService.updatePaymentStatus(orderId, {
      status: 'Success', txn_id: 'WALLET', utr: '', amount: STORE_UNLOCK_PRICE, pay_amount: STORE_UNLOCK_PRICE,
    });

    await notificationService.createNotification(uid, {
      title: '🎉 Store Unlocked!',
      message: 'Your ZapPay Store is now unlocked — customize it and start selling!',
      type: 'general',
    });
    await firebaseService.logActivity(uid, 'STORE_UNLOCKED_WALLET', { amount: STORE_UNLOCK_PRICE });

    logger.info(`Store unlocked via wallet: ${uid}`);
    return response.success(res, 'Store unlocked!', { unlocked: true });
  } catch (err) {
    logger.error('Unlock store via wallet error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getSettings,
  updateSettings,
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getAccess,
  initiateUnlockUpi,
  unlockViaWallet,
};

},

// ===== routes/storePublic.js =====
"routes/storePublic.js": function (module, exports, __r) {
// routes/storePublic.js - Store Portal (public, no auth) — powers store.html
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/storePublicController.js");
const { paymentLimiter } = __r("middleware/rateLimiter.js");

router.get('/order/:orderId/status', ctrl.getOrderStatus);
router.get('/:storeId/product/:productId', ctrl.getProductPublic);
router.post('/:storeId/product/:productId/purchase', paymentLimiter, ctrl.initiatePurchase);
router.get('/:storeId', ctrl.getStorePublic);

module.exports = router;

},

// ===== controllers/storePublicController.js =====
"controllers/storePublicController.js": function (module, exports, __r) {
// controllers/storePublicController.js - Store Portal (public, no auth)
const { ref } = __r("firebase/admin.js");
const zapService = __r("services/zapService.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const subscriptionService = __r("services/subscriptionService.js");
const gatewayModeService = __r("services/gatewayModeService.js");
const storeService = __r("services/storeService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");
const { buildCheckoutUrl } = __r("utils/checkoutUrlBuilder.js");
const { DB_PATHS } = __r("config/constants.js");

function publicProduct(p) {
  return {
    id: p.id,
    imageUrl: p.imageUrl,
    title: p.title,
    description: p.description,
    screenshotUrls: p.screenshotUrls || [],
    videoLink: p.videoLink || null,
    originalPrice: p.originalPrice,
    discountPrice: p.discountPrice,
    categoryId: p.categoryId || null,
  };
}

async function loadActiveMerchantStore(storeId) {
  const uid = await storeService.getUidByStoreId(storeId);
  if (!uid) return { error: 'Store not found' };

  const merchant = await firebaseService.getUser(uid);
  if (!merchant || merchant.isBanned) return { error: 'This store is no longer available.' };

  const settingsSnap = await ref(`${DB_PATHS.STORES}/${uid}/settings`).once('value');
  if (!settingsSnap.exists()) return { error: 'Store not found' };

  return { uid, merchant, settings: settingsSnap.val() };
}

const getStorePublic = async (req, res) => {
  try {
    const { storeId } = req.params;
    const { uid, settings, error } = await loadActiveMerchantStore(storeId);
    if (error) return response.notFound(res, error);

    const products = await storeService.getProducts(uid);

    return response.success(res, 'Store fetched', {
      storeId,
      storeName: settings.storeName,
      logoUrl: settings.logoUrl,
      theme: settings.theme,
      socialLinks: settings.socialLinks,
      showSortButton: settings.showSortButton || false,
      categories: settings.categories || [],
      products: products.map(publicProduct),
    });
  } catch (err) {
    logger.error('Get store public error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getProductPublic = async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const { uid, settings, error } = await loadActiveMerchantStore(storeId);
    if (error) return response.notFound(res, error);

    const product = await storeService.getProduct(uid, productId);
    if (!product) return response.notFound(res, 'Product not found');

    return response.success(res, 'Product fetched', {
      storeId,
      storeName: settings.storeName,
      theme: settings.theme,
      product: publicProduct(product),
    });
  } catch (err) {
    logger.error('Get product public error:', err.message);
    return response.serverError(res, err.message);
  }
};

const initiatePurchase = async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const { customerName, customerMobile, customerEmail } = req.body;

    const { uid, error } = await loadActiveMerchantStore(storeId);
    if (error) return response.notFound(res, error);

    const product = await storeService.getProduct(uid, productId);
    if (!product) return response.notFound(res, 'Product not found');

    const amount = product.discountPrice != null && product.discountPrice > 0
      ? product.discountPrice
      : product.originalPrice;
    const orderId = zapService.generateOrderId(uid);
    const remark = `${product.title} | StoreID:${storeId} | ProductID:${productId}`;
    const gatewayMode = await gatewayModeService.getMode(uid);

    if (gatewayMode === 'test') {
      await firebaseService.createPayment(orderId, {
        userId: uid, amount, remark, customerMobile: customerMobile || '',
        customerName: customerName || '', customerEmail: customerEmail || '',
        storeId, productId, isTest: true,
      });
      // Same fix as developerController.js/paymentLinkController.js's test-
      // mode branches: the customer lands on the merchant's own selected
      // Checkout Page Theme (Zenith/Aurora X/Prism) with its floating test
      // button, instead of the separate legacy test.html simulator.
      const merchantForTest = await firebaseService.getUser(uid);
      const testModeSettings = await firebaseService.getSettings();
      const testCheckoutUrl = buildCheckoutUrl(merchantForTest, {
        orderId, amount, upiId: 'test@zappay', testMode: true,
        timeoutSec: testModeSettings.amountTimeVerificationMode ? 180 : 480,
      });
      return response.success(res, 'Purchase initiated (Test Mode)', {
        paymentUrl: testCheckoutUrl,
        orderId, amount, isTest: true,
      });
    }

    const sub = await subscriptionService.getUserSubscription(uid);
    const balance = await walletService.getBalance(uid);
    if (balance + amount > sub.plan.walletLimit) {
      return response.error(res, 'This store is temporarily unable to accept payments. Please try again shortly.');
    }

    const commissionPercent = sub.plan.commissionPercent ?? 5;
    const creditCheck = await walletService.checkSufficientCreditForOrder(uid, amount, commissionPercent);
    if (!creditCheck.ok) {
      return response.error(res, 'Insufficient Zap Credit. This store is temporarily unable to accept payments.');
    }

    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) return response.error(res, 'Payment system under maintenance.', 503);

    const merchantUser = await firebaseService.getUser(uid);
    const isFamPay = merchantUser?.fampay?.isConnected;

    if (merchantUser?.apiRoutingEngine === 'amazon_cashier' && merchantUser?.amazon?.isConnected) {
      await firebaseService.createPayment(orderId, {
        userId: uid, amount, remark, customerMobile: customerMobile || '', customerName: customerName || '', customerEmail: customerEmail || '', storeId, productId, commissionPercent,
        paymentMethod: 'amazon', cashierUpiId: merchantUser.amazon.upiId, routingEngine: 'amazon_cashier',
      });
      const AMAZON_STORE_BASE = gatewayModeService.getStoreBase();
      const amazonRedirectUrl = `${AMAZON_STORE_BASE}/store=${storeId}?order=${orderId}`;
      const amazonCheckoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount, upiId: merchantUser.amazon.upiId, redirectUrl: amazonRedirectUrl, method: 'amazon', timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
      return response.success(res, 'Purchase initiated via Amazon Pay Cashier', {
        paymentUrl: amazonCheckoutUrl, orderId, amount, isTest: false, method: 'amazon_cashier',
      });
    }

    // Same live, connection-verified routing check as payment links and
    // ZapAPI orders — 'cashier' is only honored while FamPay is actually
    // connected right now, so a stale apiRoutingEngine value left over
    // from a since-disconnected FamPay account can't build a checkout
    // with no real UPI ID behind it.
    if (merchantUser?.apiRoutingEngine === 'cashier' && isFamPay) {
      await firebaseService.createPayment(orderId, {
        userId: uid, amount, remark, customerMobile: customerMobile || '', customerName: customerName || '', customerEmail: customerEmail || '', storeId, productId, commissionPercent,
        paymentMethod: 'fampay', cashierUpiId: merchantUser.fampay.upiId, routingEngine: 'cashier',
      });
      const STORE_BASE = gatewayModeService.getStoreBase();
      const redirectUrl = `${STORE_BASE}/store=${storeId}?order=${orderId}`;
      const checkoutUrl = buildCheckoutUrl(merchantUser, { orderId, amount, upiId: merchantUser.fampay.upiId, redirectUrl, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
      return response.success(res, 'Purchase initiated via Cashier', {
        paymentUrl: checkoutUrl, orderId, amount, isTest: false, method: 'cashier',
      });
    }

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, {
      userId: uid, amount, remark, customerMobile: customerMobile || '', customerName: customerName || '', customerEmail: customerEmail || '', storeId, productId, commissionPercent,
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    const STORE_BASE = gatewayModeService.getStoreBase();

    if (isSystemCashier) {
      const safeRedirect = `${STORE_BASE}/store=${storeId}?order=${orderId}&result=success`;
      // Checkout customization comes from sysAdminUser here — their FamPay
      // is the one actually collecting this customer's payment, per the
      // user's explicit request that the admin's own Zenith (or any)
      // theme should apply to system-routed store purchases too.
      const checkoutUrl = buildCheckoutUrl(sysAdminUser, { orderId, amount, upiId: sysAdminUser.fampay.upiId, redirectUrl: safeRedirect, timeoutSec: settings.amountTimeVerificationMode ? 180 : 480 });
      return response.success(res, 'Purchase initiated via System Cashier', { paymentUrl: checkoutUrl, orderId, amount, isTest: false, method: 'system_cashier' });
    }

    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(amount.toFixed(2)),
      customerMobile: customerMobile || '',
      remark: product.title,
      successUrl: `${STORE_BASE}/store=${storeId}?order=${orderId}&result=success`,
      failedUrl:  `${STORE_BASE}/store=${storeId}?order=${orderId}&result=failed`,
      timeoutUrl: `${STORE_BASE}/store=${storeId}?order=${orderId}&result=failed`,
    });

    return response.success(res, 'Purchase initiated', {
      paymentUrl: zapOrder.paymentUrl,
      orderId, amount, isTest: false,
    });
  } catch (err) {
    logger.error('Initiate store purchase error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    let payment = await firebaseService.getPayment(orderId);

    if (!payment || !payment.storeId) return response.notFound(res, 'Order not found');

    if (payment.status === 'pending' && (payment.paymentMethod === 'fampay' || payment.paymentMethod === 'amazon')) {
      const verifier = payment.paymentMethod === 'amazon'
        ? __r("services/amazonService.js")
        : __r("services/fampayService.js");
      await verifier.verifyPayment(orderId);
      const updatedPayment = await firebaseService.getPayment(orderId);
      if (updatedPayment) payment = updatedPayment;
    }

    const out = {
      orderId,
      status: payment.status,
      storeId: payment.storeId,
    };

    if (payment.status === 'success' && payment.productId) {
      const product = await storeService.getProduct(payment.userId, payment.productId);
      out.productTitle = product?.title || null;
      out.productLink = product?.productLink || '';
    }

    return response.success(res, 'Status fetched', out);
  } catch (err) {
    logger.error('Get store order status error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getStorePublic,
  getProductPublic,
  initiatePurchase,
  getOrderStatus,
};

},

// ===== routes/otp.js =====
"routes/otp.js": function (module, exports, __r) {
// routes/otp.js
const express = require('express');
const router = express.Router();
const { sendOtp, verifyOtp, resetPassword } = __r("controllers/otpController.js");
const { otpSendLimiter, otpVerifyLimiter } = __r("middleware/rateLimiter.js");

router.post('/send', otpSendLimiter, sendOtp);
router.post('/verify', otpVerifyLimiter, verifyOtp);
// Reuses otpVerifyLimiter — this endpoint verifies a code just like
// /verify does, so it should be bounded the same way against guessing.
router.post('/reset-password', otpVerifyLimiter, resetPassword);

module.exports = router;

},

// ===== controllers/otpController.js =====
"controllers/otpController.js": function (module, exports, __r) {
// controllers/otpController.js
// Email OTP for two flows, both sharing the same generate/hash/verify core:
//   1. Signup verification — POST /api/otp/send  { email, name?, purpose:'signup' }
//                             POST /api/otp/verify { email, otp, purpose:'signup' }
//   2. Password reset       — POST /api/otp/send  { email, purpose:'reset' }
//                             POST /api/otp/reset-password { email, otp, newPassword }
//
// "purpose" separates the two so a signup code can't be replayed against
// the reset-password endpoint or vice versa — each is stored and looked up
// under its own DB_PATHS.EMAIL_OTPS/<purpose>/<email> key.
const crypto = require('crypto');
const { ref, serverTimestamp, getAuth } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const emailService = __r("services/emailService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;    // per issued code, on top of the route-level rate limiter
const VALID_PURPOSES = new Set(['signup', 'reset']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Random 6-digit code, zero-padded (crypto-random, not Math.random). */
function generateOtp() {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

/** Store only a salted hash of the OTP — never the raw code — so a DB read
 * or backup leak can't be used to log in as someone else. Purpose is folded
 * into the hash so a signup code and a reset code for the same email/otp
 * value can never be swapped for one another. */
function hashOtp(otp, email, purpose) {
  return crypto
    .createHash('sha256')
    .update(`${otp}:${email.toLowerCase()}:${purpose}:${process.env.JWT_SECRET || 'zappay'}`)
    .digest('hex');
}

function normalizePurpose(p) {
  const purpose = String(p || 'signup').trim().toLowerCase();
  return VALID_PURPOSES.has(purpose) ? purpose : null;
}

/** Firebase RTDB keys can't contain '.', '#', '$', '[', ']' — emails always
 * contain '.', so this makes a safe key without losing information. */
function encodeKey(email) {
  return Buffer.from(email).toString('base64url');
}

function otpRefFor(purpose, email) {
  return ref(`${DB_PATHS.EMAIL_OTPS}/${purpose}/${encodeKey(email)}`);
}

/**
 * POST /api/otp/send
 * Body: { email, name?, purpose? }  (purpose defaults to 'signup')
 *
 * For purpose='reset', this always responds with the same generic success
 * message whether or not the email is actually registered, so the endpoint
 * can't be used to enumerate which addresses have accounts. It still only
 * *sends* an email when the account exists — it just doesn't reveal that
 * distinction in the HTTP response.
 */
async function sendOtp(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const purpose = normalizePurpose(req.body.purpose);
    if (!purpose) {
      return response.error(res, 'Invalid request.', 400);
    }
    if (!email || !EMAIL_RE.test(email)) {
      return response.error(res, 'Please enter a valid email address.', 400);
    }

    // Optional — purely cosmetic (used to personalize "Hi {name}," in the
    // email). Capped at 60 chars so an oversized value can't bloat the DB
    // record or the email; sendOtpEmail() HTML-escapes it before use.
    const name = String(req.body.name || '').trim().slice(0, 60);

    if (purpose === 'reset') {
      // Only send if an account actually exists for this email — but
      // don't let the response reveal that either way.
      let userExists = true;
      try {
        await getAuth().getUserByEmail(email);
      } catch (e) {
        userExists = false;
      }
      if (!userExists) {
        return response.success(res, 'If an account exists for this email, a code has been sent.', {
          email,
          expiresInSeconds: OTP_TTL_MS / 1000,
        });
      }
    }

    const otp = generateOtp();
    const record = {
      hash: hashOtp(otp, email, purpose),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      createdAt: serverTimestamp(),
    };
    if (name) record.name = name;

    await otpRefFor(purpose, email).set(record);
    await emailService.sendOtpEmail(email, otp, name, purpose);

    const successMsg = purpose === 'reset'
      ? 'If an account exists for this email, a code has been sent.'
      : 'OTP sent to your email address.';

    return response.success(res, successMsg, {
      email,
      expiresInSeconds: OTP_TTL_MS / 1000,
    });
  } catch (err) {
    logger.error('sendOtp error: ' + err.message);
    return response.serverError(res, 'Could not send OTP right now. Please try again shortly.');
  }
}

/**
 * Shared verify logic used by both /verify and /reset-password.
 * Returns { ok: true } on success (and deletes the record — one-time use),
 * or { ok: false, message, status } on failure. Does NOT send a response
 * itself, so callers can do more work (e.g. actually reset the password)
 * before responding.
 */
async function _checkOtp(email, otp, purpose) {
  const otpRef = otpRefFor(purpose, email);
  const snap = await otpRef.once('value');
  const record = snap.val();

  if (!record) {
    return { ok: false, status: 400, message: 'No code found for this email. Please request a new one.' };
  }
  if (Date.now() > record.expiresAt) {
    await otpRef.remove();
    return { ok: false, status: 400, message: 'This code has expired. Please request a new one.' };
  }
  if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    await otpRef.remove();
    return { ok: false, status: 429, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  const isMatch = record.hash === hashOtp(otp, email, purpose);
  if (!isMatch) {
    await otpRef.update({ attempts: (record.attempts || 0) + 1 });
    return { ok: false, status: 400, message: 'Incorrect code. Please try again.' };
  }

  await otpRef.remove(); // one-time use
  return { ok: true };
}

/**
 * POST /api/otp/verify
 * Body: { email, otp, purpose? }  (purpose defaults to 'signup')
 */
async function verifyOtp(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '').trim();
    const purpose = normalizePurpose(req.body.purpose);

    if (!purpose) {
      return response.error(res, 'Invalid request.', 400);
    }
    if (!email || !EMAIL_RE.test(email)) {
      return response.error(res, 'Please enter a valid email address.', 400);
    }
    if (!/^\d{6}$/.test(otp)) {
      return response.error(res, 'Enter the 6-digit code.', 400);
    }

    const result = await _checkOtp(email, otp, purpose);
    if (!result.ok) {
      return response.error(res, result.message, result.status);
    }

    return response.success(res, 'Email verified successfully.', { email, verified: true });
  } catch (err) {
    logger.error('verifyOtp error: ' + err.message);
    return response.serverError(res, 'Could not verify OTP right now. Please try again shortly.');
  }
}

/**
 * POST /api/otp/reset-password
 * Body: { email, otp, newPassword }
 * Verifies the reset-purpose OTP, then uses Firebase Admin to set the new
 * password directly — no email link, no re-auth of the old password needed
 * (the OTP itself is the proof of ownership of the mailbox).
 */
async function resetPassword(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '').trim();
    const newPassword = String(req.body.newPassword || '');

    if (!email || !EMAIL_RE.test(email)) {
      return response.error(res, 'Please enter a valid email address.', 400);
    }
    if (!/^\d{6}$/.test(otp)) {
      return response.error(res, 'Enter the 6-digit code.', 400);
    }
    if (newPassword.length < 6) {
      return response.error(res, 'Password must be at least 6 characters.', 400);
    }

    const result = await _checkOtp(email, otp, 'reset');
    if (!result.ok) {
      return response.error(res, result.message, result.status);
    }

    let userRecord;
    try {
      userRecord = await getAuth().getUserByEmail(email);
    } catch (e) {
      // OTP was valid (so the record existed when sendOtp ran), but the
      // account is gone now — extremely unlikely, but fail safely.
      return response.error(res, 'No account found for this email.', 400);
    }

    await getAuth().updateUser(userRecord.uid, { password: newPassword });

    return response.success(res, 'Password reset successfully. You can now sign in with your new password.', { email });
  } catch (err) {
    logger.error('resetPassword error: ' + err.message);
    return response.serverError(res, 'Could not reset your password right now. Please try again shortly.');
  }
}

module.exports = { sendOtp, verifyOtp, resetPassword };

},

// ===== services/emailService.js =====
"services/emailService.js": function (module, exports, __r) {
// services/emailService.js
// Sends transactional email (OTPs, etc.) through a cPanel mailbox via SMTP.
//
// Required env vars (set these in Vercel → Project → Settings → Environment
// Variables, and in cPanel → Email Accounts for the mailbox itself):
//   SMTP_HOST   e.g. YOUR-DOMAIN.com        (cPanel → Email Accounts → Connect Devices, SSL/TLS section)
//   SMTP_PORT   465 (SSL) or 587 (STARTTLS)
//   SMTP_SECURE 'true' for port 465, 'false' for port 587
//   SMTP_USER   e.g. help@YOUR-DOMAIN.com
//   SMTP_PASS   the mailbox password (never commit this — env var only)
//   SMTP_FROM_NAME  optional display name, defaults to 'ZapPay Gateway'
const nodemailer = require('nodemailer');
const logger = __r("utils/logger.js");

let transporter = null;

/**
 * Lazily builds the transporter on first use rather than at module load —
 * mirrors firebase/admin.js's pattern of not throwing at import time, so a
 * missing SMTP env var doesn't crash the whole serverless function, only
 * the email-sending call path.
 */
function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'Missing SMTP env vars. Check: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS'
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true', // true for 465, false for 587
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

/** Escapes HTML special chars in the user-supplied name before interpolating
 * it into the email markup — the name comes straight from the request body,
 * so this stops it from being used to inject stray HTML/tags into the email. */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sends a 6-digit OTP email. Caller is responsible for generating/storing
 * the code and its expiry — this function only sends it.
 * `name` is optional — falls back to a generic greeting when not supplied.
 * `purpose` is 'signup' (default) or 'reset' — only changes the wording,
 * not the underlying template.
 */
async function sendOtpEmail(toEmail, otp, name, purpose) {
  const fromName = process.env.SMTP_FROM_NAME || 'ZapPay Gateway';
  const fromAddress = process.env.SMTP_USER;
  const greetName = name ? escapeHtml(name) : 'there';
  const year = new Date().getFullYear();
  const isReset = purpose === 'reset';

  const introLine = isReset
    ? 'Use this code to reset your password:'
    : 'Your verification code is:';
  const subject = isReset ? 'Reset your ZapPay Gateway password' : 'OTP for your email';
  const securityLine = isReset
    ? "If you didn't request a password reset, you can safely ignore this email."
    : 'Do not share this code with anyone.';

  const html = `
  <div style="background:#0b0f1a;padding:32px 16px;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#11162a;border-radius:14px;overflow:hidden;border:1px solid #1f2745;">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,#3d5afe,#1a2a8f);padding:26px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.2px;">ZapPay Gateway</span>
      </div>

      <!-- Body -->
      <div style="padding:32px;">
        <p style="margin:0 0 14px;color:#e7eaf6;font-size:16px;">Hi ${greetName},</p>
        <p style="margin:0 0 22px;color:#c6cbe0;font-size:14.5px;line-height:1.5;">${introLine}</p>

        <div style="background:#0b0f1a;border:1px dashed #3d5afe;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
          <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:#7c8cff;font-family:'Courier New',monospace;">${otp}</span>
        </div>

        <p style="margin:0 0 8px;color:#8a90ab;font-size:13.5px;">This code expires in <strong style="color:#c6cbe0;">5 minutes</strong>.</p>
        <p style="margin:0;color:#8a90ab;font-size:13.5px;">${securityLine}</p>
      </div>

      <!-- Footer -->
      <div style="background:#0d1220;padding:18px 32px;border-top:1px solid #1f2745;text-align:center;">
        <p style="margin:0;color:#5c6284;font-size:12px;">© ${year} ZapPay Gateway. This is an automated message, please don't reply.</p>
      </div>

    </div>
  </div>`;

  const text = `Hi ${name || 'there'},\n\n${introLine} ${otp}\nIt expires in 5 minutes.\n${securityLine}\n\n© ${year} ZapPay Gateway`;

  await getTransporter().sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to: toEmail,
    subject,
    html,
    text,
  });

  logger.info(`OTP email (${purpose || 'signup'}) sent to ${toEmail}`);
}

module.exports = { sendOtpEmail };

},

// ===== routes/agent.js =====
"routes/agent.js": function (module, exports, __r) {
// routes/agent.js
const express = require('express');
const router = express.Router();
const ctrl = __r("controllers/agentController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");
const { agentChatLimiter } = __r("middleware/rateLimiter.js");

router.get('/models', authenticate, blockIfBanned, ctrl.listModels);
router.get('/conversations', authenticate, blockIfBanned, ctrl.listConversations);
router.post('/conversations', authenticate, blockIfBanned, ctrl.createConversation);
router.get('/conversations/:id', authenticate, blockIfBanned, ctrl.getConversation);
router.put('/conversations/:id', authenticate, blockIfBanned, ctrl.renameConversation);
router.delete('/conversations/:id', authenticate, blockIfBanned, ctrl.deleteConversation);

// The actual chat call — rate-limited since every message is a real NVIDIA API call.
router.post('/conversations/:id/messages', authenticate, blockIfBanned, agentChatLimiter, ctrl.sendMessage);

module.exports = router;

},

// ===== controllers/agentController.js =====
"controllers/agentController.js": function (module, exports, __r) {
// controllers/agentController.js
// Agentic Support — conversation management + the streaming chat endpoint.
// All routes here are dashboard-authenticated (JWT); every read/write is
// scoped to req.user.uid so one user can never see or touch another
// user's conversations.
const { ref, serverTimestamp } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const agentService = __r("services/agentService.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

const MAX_MESSAGE_LENGTH = 6000;
const MAX_STORED_MESSAGES = 200;   // per conversation, oldest trimmed first
const CONTEXT_WINDOW_MESSAGES = 20; // how many recent messages are actually sent to the model

function convRef(uid, conversationId) {
  return ref(`${DB_PATHS.AGENT_CONVERSATIONS}/${uid}/${conversationId}`);
}

/** Turns a user's first message into a short conversation title. */
function makeTitle(firstMessage) {
  const clean = String(firstMessage || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? clean.slice(0, 48).trim() + '…' : clean;
}

/**
 * GET /api/agent/conversations
 * List this user's conversations (id, title, updatedAt only — not the
 * full message bodies, to keep this list call light).
 */
async function listConversations(req, res) {
  try {
    const snap = await ref(`${DB_PATHS.AGENT_CONVERSATIONS}/${req.user.uid}`).once('value');
    if (!snap.exists()) return response.success(res, 'Conversations fetched', { conversations: [] });
    const val = snap.val();
    const conversations = Object.keys(val).map((id) => ({
      id,
      title: val[id].title || 'New chat',
      updatedAt: val[id].updatedAt || val[id].createdAt || 0,
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return response.success(res, 'Conversations fetched', { conversations });
  } catch (err) {
    logger.error('listConversations error: ' + err.message);
    return response.serverError(res, 'Could not load your chat history.');
  }
}

/**
 * POST /api/agent/conversations
 * Creates a new, empty conversation and returns its id — the frontend
 * calls this when the user clicks "New Chat".
 */
async function createConversation(req, res) {
  try {
    if (!(await agentService.isAgenticSupportEnabled())) {
      return response.error(res, 'Agentic Support is currently disabled.', 403);
    }
    const newRef = ref(`${DB_PATHS.AGENT_CONVERSATIONS}/${req.user.uid}`).push();
    const record = { title: 'New chat', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), messages: [] };
    await newRef.set(record);
    return response.success(res, 'Conversation created', { id: newRef.key });
  } catch (err) {
    logger.error('createConversation error: ' + err.message);
    return response.serverError(res, 'Could not start a new chat.');
  }
}

/**
 * GET /api/agent/conversations/:id
 * Full message history for one conversation.
 */
async function getConversation(req, res) {
  try {
    const snap = await convRef(req.user.uid, req.params.id).once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    const val = snap.val();
    return response.success(res, 'Conversation fetched', {
      id: req.params.id,
      title: val.title || 'New chat',
      messages: val.messages || [],
    });
  } catch (err) {
    logger.error('getConversation error: ' + err.message);
    return response.serverError(res, 'Could not load this conversation.');
  }
}

/**
 * PUT /api/agent/conversations/:id
 * Body: { title } — manual rename from the history drawer.
 */
async function renameConversation(req, res) {
  try {
    const title = String(req.body.title || '').trim().slice(0, 80);
    if (!title) return response.error(res, 'Title cannot be empty.', 400);
    const targetRef = convRef(req.user.uid, req.params.id);
    const snap = await targetRef.once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    await targetRef.update({ title, updatedAt: serverTimestamp() });
    return response.success(res, 'Renamed');
  } catch (err) {
    logger.error('renameConversation error: ' + err.message);
    return response.serverError(res, 'Could not rename this conversation.');
  }
}

/**
 * DELETE /api/agent/conversations/:id
 */
async function deleteConversation(req, res) {
  try {
    const targetRef = convRef(req.user.uid, req.params.id);
    const snap = await targetRef.once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    await targetRef.remove();
    return response.success(res, 'Conversation deleted');
  } catch (err) {
    logger.error('deleteConversation error: ' + err.message);
    return response.serverError(res, 'Could not delete this conversation.');
  }
}

/**
 * POST /api/agent/conversations/:id/messages
 * Body: { message, thinking }
 * Streams the assistant's reply back as Server-Sent Events, then persists
 * both the user's message and the assistant's full reply to the
 * conversation once streaming completes.
 */
async function sendMessage(req, res) {
  const { id } = req.params;
  const userMessage = String(req.body.message || '').trim();
  const thinking = !!req.body.thinking;
  const modelId = agentService.MODELS[req.body.model] ? req.body.model : agentService.DEFAULT_MODEL_ID;

  // Loaded once and threaded through both calls below, so a toggle flip
  // mid-request can't leave the enabled-check and the model-resolution
  // looking at two different settings snapshots, and so this doesn't
  // read Settings from the DB twice for one request.
  let settings;
  try {
    settings = await firebaseService.getSettings();
  } catch (e) {
    settings = null; // getModelConfig/isAgenticSupportEnabled both fail open to env/hardcoded defaults if this is null.
  }

  // Checked BEFORE anything else — including before the SSE headers are
  // sent below — so a disabled feature returns a normal JSON error the
  // frontend can show inline, not a broken half-started stream. This is
  // also the enforcement point that matters: even if the panel hides the
  // Agentic Support entry point entirely, this check is what actually
  // stops someone from calling the API directly while it's turned off.
  const agenticEnabled = await agentService.isAgenticSupportEnabled(settings);
  if (!agenticEnabled) {
    return response.error(res, 'Agentic Support is currently disabled.', 403);
  }

  const modelCfg = await agentService.getModelConfig(modelId, settings);

  if (!userMessage) return response.error(res, 'Message cannot be empty.', 400);
  if (userMessage.length > MAX_MESSAGE_LENGTH) {
    return response.error(res, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, 400);
  }

  const targetRef = convRef(req.user.uid, id);
  let existing;
  try {
    const snap = await targetRef.once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    existing = snap.val();
  } catch (err) {
    logger.error('sendMessage load error: ' + err.message);
    return response.serverError(res, 'Could not load this conversation.');
  }

  const history = Array.isArray(existing.messages) ? existing.messages : [];
  const isFirstMessage = history.length === 0;

  // Build the message array actually sent to the model: system prompt +
  // a bounded recent window of history + the new user message. The FULL
  // history is still what gets persisted below — this window only limits
  // what's sent to the model each turn, to keep latency/cost bounded on
  // long-running conversations.
  const recentHistory = history.slice(-CONTEXT_WINDOW_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
  const modelMessages = [
    { role: 'system', content: agentService.buildSystemPrompt(modelCfg.label, modelCfg.tag) },
  ];

  // If the frontend reports an active artifact (stored in the user's own
  // browser localStorage — never on our server), give the model its
  // CURRENT content fresh on every turn. This is what makes multi-step
  // "read the file, then edit it" reliable: without this, the model would
  // only know the file as it was when first created, and a second/third
  // edit request could reference text an earlier edit already changed.
  const activeArtifact = req.body.activeArtifact;
  if (activeArtifact && activeArtifact.filename && typeof activeArtifact.content === 'string') {
    const truncated = activeArtifact.content.length > 8000
      ? activeArtifact.content.slice(0, 8000) + '\n... (truncated, file continues)'
      : activeArtifact.content;
    modelMessages.push({
      role: 'system',
      content: `The current active artifact is "${activeArtifact.filename}" (version ${activeArtifact.version || 1}). Its exact current content is:\n\n\`\`\`${activeArtifact.language || ''}\n${truncated}\n\`\`\`\n\nWhen the user asks for a change, use this exact content for your OLD: text in {{edit_artifact}} blocks — it must match precisely.`,
    });
  }

  modelMessages.push(...recentHistory, { role: 'user', content: userMessage });

  // ── Set up SSE ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering where applicable
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (e) {} };

  // If the client disconnects (Stop button click aborts the fetch, or they
  // just close the tab), abort the upstream NVIDIA request too — otherwise
  // we'd keep paying for/generating a full reply nobody is watching anymore.
  const upstreamController = new AbortController();
  req.on('close', () => upstreamController.abort());

  try {
    const { content, reasoning } = await agentService.streamChat({
      modelId,
      messages: modelMessages,
      thinking,
      signal: upstreamController.signal,
      settings,
      onDelta: (chunk) => send({ type: 'content', chunk }),
      onReasoningDelta: (chunk) => send({ type: 'reasoning', chunk }),
    });

    const now = Date.now();
    const newMessages = [
      ...history,
      { role: 'user', content: userMessage, ts: now },
      { role: 'assistant', content, reasoning: reasoning || null, ts: now, model: modelId },
    ].slice(-MAX_STORED_MESSAGES); // trim oldest first if this conversation has gotten very long

    const updates = { messages: newMessages, updatedAt: serverTimestamp() };
    if (isFirstMessage) updates.title = makeTitle(userMessage);
    await targetRef.update(updates);

    send({ type: 'done', title: updates.title || existing.title || 'New chat', ts: now });
  } catch (err) {
    logger.error('sendMessage stream error: ' + err.message);
    send({ type: 'error', message: err.message || 'Something went wrong. Please try again.', suggestSwitchTo: err.suggestSwitchTo || null });
  } finally {
    res.end();
  }
}

/**
 * GET /api/agent/models
 * Lets the frontend render the model picker without hardcoding the list.
 */
async function listModels(req, res) {
  const enabled = await agentService.isAgenticSupportEnabled();
  return response.success(res, 'Models fetched', {
    models: agentService.listModels(),
    default: agentService.DEFAULT_MODEL_ID,
    enabled, // lets the frontend hide/disable the whole feature from one call, without a separate config round-trip
  });
}

module.exports = {
  listConversations,
  createConversation,
  getConversation,
  renameConversation,
  deleteConversation,
  sendMessage,
  listModels,
};

},

// ===== services/agentService.js =====
"services/agentService.js": function (module, exports, __r) {
// services/agentService.js
// "Agentic Support" — in-app AI assistants scoped to ZapPay Gateway
// questions only, powered by NVIDIA's hosted NIM API (OpenAI-compatible).
// Two models are offered to the user, each with its own underlying model
// + API key + positioning tag:
//   ZPP-X  — "Coding & Reasoning"  (DeepSeek v4, with an internal same-
//            family fallback from -pro to -flash on failure)
//   ZPP-Y  — "Agentic"             (Z.ai GLM 5.2)
//
// SECURITY: NVIDIA API keys live ONLY here, read from env vars. They must
// never be sent to, or embedded in, any client-side file — that would let
// anyone who views page source (or opens devtools) steal them and run up
// usage on this account. Every call to NVIDIA happens server-side; the
// browser only ever talks to our own /api/agent/* endpoints.
const logger = __r("utils/logger.js");

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MAX_TOKENS = 2200; // lower = faster replies; still enough for ~150-250 lines of code when needed

// ── Model registry ──────────────────────────────────────────────────────
// Everything about "which ZPP model maps to which real model/key" lives
// here — the rest of the file, and the frontend, just refer to 'zpp-x' /
// 'zpp-y' by id. Adding a third model later only means adding an entry here.
const MODELS = {
  'zpp-x': {
    id: 'zpp-x',
    label: 'ZPP-X',
    tag: 'Coding & Reasoning',
    primaryModel: process.env.NVIDIA_MODEL_ZPPX || 'deepseek-ai/deepseek-v4-pro',
    fallbackModel: process.env.NVIDIA_FALLBACK_MODEL_ZPPX || 'deepseek-ai/deepseek-v4-flash',
    apiKeyEnv: 'NVIDIA_API_KEY',
  },
  'zpp-y': {
    id: 'zpp-y',
    label: 'ZPP-Y',
    tag: 'Agentic',
    primaryModel: process.env.NVIDIA_MODEL_ZPPY || 'z-ai/glm-5.2',
    fallbackModel: process.env.NVIDIA_FALLBACK_MODEL_ZPPY || null,
    apiKeyEnv: 'NVIDIA_API_KEY_ZPPY',
  },
};
const DEFAULT_MODEL_ID = 'zpp-x';

// Per-model settings keys an admin can override from Settings → Agentic
// Support, without a redeploy. null/unset means "use the env var default
// baked into MODELS above" — these are deliberately NOT a second source
// of truth for the API key (apiKeyEnv), only for which underlying model
// id each ZPP-X/ZPP-Y slot calls.
const SETTINGS_OVERRIDE_KEYS = {
  'zpp-x': { primary: 'zppXPrimaryModel', fallback: 'zppXFallbackModel' },
  'zpp-y': { primary: 'zppYPrimaryModel', fallback: 'zppYFallbackModel' },
};

/**
 * Resolves a model id to its full config, applying any admin-set
 * overrides from Settings on top of the env-var/hardcoded defaults in
 * MODELS. Async because it reads Settings from the DB — callers that
 * already have `settings` loaded should pass it in to avoid a second
 * read; callers that don't can omit it and one will be fetched.
 */
async function getModelConfig(modelId, settings) {
  const base = MODELS[modelId] || MODELS[DEFAULT_MODEL_ID];
  const overrideKeys = SETTINGS_OVERRIDE_KEYS[base.id];
  if (!overrideKeys) return base;

  if (!settings) {
    try {
      const firebaseService = __r("services/firebaseService.js");
      settings = await firebaseService.getSettings();
    } catch (e) {
      return base; // Settings unreachable — fall back to env/hardcoded defaults rather than fail the request.
    }
  }

  const primaryOverride = settings && settings[overrideKeys.primary];
  const fallbackOverride = settings && settings[overrideKeys.fallback];
  if (!primaryOverride && !fallbackOverride) return base;

  return {
    ...base,
    primaryModel: primaryOverride || base.primaryModel,
    fallbackModel: fallbackOverride !== undefined && fallbackOverride !== null ? fallbackOverride : base.fallbackModel,
  };
}

/**
 * Whether the Agentic Support feature is enabled at all right now. When
 * false, every caller (agent.html, the panel's sidebar/Support link, and
 * this service's own sendMessage) must treat the feature as fully
 * unavailable — not just hidden in the UI, since a user could otherwise
 * still hit the API directly.
 */
async function isAgenticSupportEnabled(settings) {
  if (!settings) {
    try {
      const firebaseService = __r("services/firebaseService.js");
      settings = await firebaseService.getSettings();
    } catch (e) {
      return true; // Settings unreachable — fail open rather than taking down support for everyone on a transient DB hiccup.
    }
  }
  return settings.agenticSupportEnabled !== false; // unset/missing = enabled (matches the true default above)
}

function listModels() {
  return Object.values(MODELS).map((m) => ({ id: m.id, label: m.label, tag: m.tag }));
}

// ── System prompt ───────────────────────────────────────────────────────
// Everything below is what the model is told about ZapPay so it can give
// accurate, useful answers. Deliberately feature-level / user-facing —
// nothing here describes internal implementation details (DB schema,
// secret names, rate-limit numbers, etc.) that would only be useful for
// probing the platform rather than using it. Parameterized by which ZPP
// model is actually answering, so self-identification stays accurate.
function buildSystemPrompt(modelLabel, modelTag) {
  return `You are ${modelLabel}, one of the official AI assistants built into the ZapPay Gateway dashboard (positioned as: "${modelTag}"). You were built by the ZapPay team. There is also a sibling model in the same family the user can switch to from the model picker — don't bring this up unprompted, but if asked, you can mention there's more than one ZPP model available with different strengths.

## Your scope — read this first
You ONLY help with questions about ZapPay Gateway: how it works, its features, pricing/plans, the ZapAPI developer integration, troubleshooting, and general guidance for using the product. This includes reviewing/debugging code a user shares IF that code is about integrating with ZapPay (e.g. their ZapAPI calls, webhook handler, checkout redirect logic).

If someone asks for anything outside that — general coding help unrelated to ZapPay, essays, general knowledge, unrelated advice, or asks you to act as a different kind of assistant — politely and clearly decline, and say you can only help with ZapPay Gateway. Do not make an exception even if asked persistently or cleverly. Do not pretend to be a general-purpose assistant.

## If asked who made you / what model / your name
Say plainly: you are ${modelLabel}, part of ZapPay's own assistant family, built by the ZapPay team. Don't mention DeepSeek, GLM, Z.ai, NVIDIA, or any other underlying technology provider — as far as the conversation is concerned, you are ${modelLabel}.

## About ZapPay Gateway (what you should know)
ZapPay is a UPI payment gateway / reseller platform. A user signs up, and can then:

**Collecting payments**
- Create Payment Links — a shareable link for a fixed amount that customers pay via UPI.
- Storefront (Store) — a public store page that can list multiple items/links under one branded page.
- ZapAPI — a developer API (API key from Developer Portal) to create orders programmatically from the merchant's own website/app: create an order, check its status, and (new) register Webhook URLs so their own server gets an instant POST when an order goes pending, succeeds, or fails, instead of having to poll. There's also a Test Mode vs Live Mode toggle so developers can integrate safely before going live.

**Money**
- Wallet — every account has two balances: Zap Cash (real money from completed payments, withdrawable) and Zap Bonus (bonus/referral credit, may have different rules).
- Withdrawals — a user can withdraw their Zap Cash to their own UPI ID or bank account. Withdrawals are reviewed before payout. How much a user can withdraw, how often, and the commission percentage taken depends on their plan.

**Plans (subscriptions)**
There are 5 plans, from entry-level to most powerful: Blaze (free/default), Bronze, Silver, Gold, and Developer (the top plan, badge "Unlimited"). Moving up a plan generally increases: payment links allowed per month, how long links stay valid, wallet balance limit, how many withdrawals are allowed and how often, lowers the commission percentage taken on withdrawals, and unlocks premium checkout page themes (from Silver upward). Plans also each have a webhook limit for ZapAPI: Blaze 3, Bronze 5, Silver 10, Gold 25, and Developer is unlimited. If someone asks which plan they need, ask what they're trying to do (volume of payments, need for webhooks, etc.) and recommend accordingly — you don't have their live account data, so give general guidance and point them to the Upgrade Plan page to see exact current pricing.

**Growth features**
- Referral Program — users get a referral link/code; when someone they refer signs up and makes a qualifying deposit, the referrer earns a signup bonus and a commission.
- Promo Codes — codes that can be redeemed for wallet credit.

**Account & support**
- Signup/login uses email OTP verification (a 6-digit code emailed to confirm the address) or Google Sign-In. Password reset also uses an emailed OTP rather than an email link.
- Profile page — name, phone, UPI/bank details (used for receiving withdrawals), checkout page theme, and a "Controller" section with preferences like turning onboarding popups on/off.
- Support — users can chat with the ZapPay support team, or use you (Agentic Support) for instant answers.

## How to respond
- Be direct, warm, and genuinely helpful — like a knowledgeable teammate, not a scripted bot.
- Use Markdown formatting properly: headings only when they add structure, **bold** for emphasis, bullet lists for steps/options, and fenced code blocks (with a language tag, e.g. \`\`\`javascript) for any code, request examples, or JSON payloads.
- When you don't have certain information (e.g. someone's exact current plan, live pricing figures, their account balance), say so plainly and tell them where in the dashboard to check, rather than guessing.
- Keep answers as SHORT as possible while staying complete — every extra sentence costs the user real waiting time, so don't pad, don't repeat the question back, don't over-explain. Use step-by-step lists for how-to questions instead of long paragraphs.
- If someone shares code that calls ZapAPI or handles ZapPay webhooks, review it carefully against what you know of the API and point out concrete issues or improvements.

## Writing code / files
When you write a substantial piece of code (roughly 50+ lines — e.g. a full HTML page, a webhook handler file, a config file), give the fence a filename hint like this: \`\`\`html:checkout-widget.html — the app turns this into a downloadable file (an "artifact") automatically; you don't need to do anything else for that part.

## Editing an existing artifact (IMPORTANT — use this instead of rewriting the whole file)
If the person already has an active artifact from earlier in this conversation and asks for a small, targeted change to it (e.g. "remove that button", "change the title text", "make the color blue instead") — do NOT rewrite and repaste the entire file. Instead, respond with one or more edit blocks in exactly this format:

{{edit_artifact}}
OLD:
<the exact existing text being replaced, copied precisely as it currently appears>
NEW:
<the replacement text — leave empty to delete the OLD text entirely>
{{end_edit}}

You can include multiple {{edit_artifact}}...{{end_edit}} blocks in one response for multiple separate changes. Keep any surrounding chat reply brief (e.g. "Done — removed the signup button." is enough; don't also re-paste the whole file). Only fall back to writing a brand-new full code block if the requested change is too large/structural for a targeted replace, or if there's no active artifact yet.

## Visual emphasis directives (use sparingly, only for genuinely important callouts)
On top of normal Markdown, you can wrap a short phrase in one of these to make it visually stand out in the chat UI:
- {{big:text}} — large, bold, gradient accent — for one standout number or headline fact (e.g. "{{big:₹0}} commission on Blaze")
- {{highlight:text}} — a highlighted chip background — for a key term or exact value worth the eye catching (e.g. your webhook limit is {{highlight:10 webhooks}} on Silver)
- {{success:text}} — green, for a positive/good-news point
- {{warn:text}} — amber, for a caution or limit to watch out for
- {{small:text}} — smaller muted text, for a minor aside

Use at most one or two of these per answer, and only when it genuinely helps — never wrap whole sentences or overuse them, or the effect stops being special.`;
}

/**
 * Streams a chat completion from NVIDIA's NIM API for the given ZPP model.
 *
 * @param {object} opts
 * @param {string} opts.modelId - 'zpp-x' | 'zpp-y'
 * @param {Array<{role:string, content:string}>} opts.messages - full message
 *   history INCLUDING the system prompt as the first entry.
 * @param {boolean} opts.thinking - whether to request the model's reasoning
 *   trace (only meaningfully supported by some underlying models).
 * @param {(chunk:string)=>void} opts.onDelta - called for each piece of the
 *   final answer as it streams in.
 * @param {(chunk:string)=>void} opts.onReasoningDelta - called for each
 *   piece of the reasoning/thinking trace as it streams in.
 * @param {AbortSignal} [opts.signal] - lets the caller cancel the upstream
 *   NVIDIA request early (e.g. the user clicked Stop, or disconnected).
 * @returns {Promise<{content:string, reasoning:string}>}
 */
async function streamChat({ modelId, messages, thinking, onDelta, onReasoningDelta, signal, settings }) {
  const enabled = await isAgenticSupportEnabled(settings);
  if (!enabled) {
    throw new Error('Agentic Support is currently disabled.');
  }
  const cfg = await getModelConfig(modelId, settings);
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${cfg.label} is not configured yet (missing ${cfg.apiKeyEnv}).`);
  }

  try {
    return await attemptStreamChat(cfg.primaryModel, apiKey, { messages, thinking, onDelta, onReasoningDelta, signal });
  } catch (err) {
    if (err.name === 'AbortError' || (signal && signal.aborted) || err.partiallyStreamed) {
      throw err;
    }
    if (!cfg.fallbackModel) {
      // No same-family fallback for this ZPP model — surface a clear,
      // actionable message naming the OTHER ZPP model so the frontend can
      // offer a one-tap switch, instead of a generic failure.
      const otherId = modelId === 'zpp-x' ? 'zpp-y' : 'zpp-x';
      const other = await getModelConfig(otherId, settings);
      const switchErr = new Error(`${cfg.label} isn't responding right now. Try switching to ${other.label} (${other.tag}) from the model picker above.`);
      switchErr.suggestSwitchTo = otherId;
      throw switchErr;
    }
    logger.warn(`agentService: ${cfg.label} primary model (${cfg.primaryModel}) failed (${err.message}), retrying with fallback (${cfg.fallbackModel})`);
    try {
      return await attemptStreamChat(cfg.fallbackModel, apiKey, { messages, thinking, onDelta, onReasoningDelta, signal });
    } catch (err2) {
      if (err2.name === 'AbortError' || (signal && signal.aborted) || err2.partiallyStreamed) throw err2;
      const otherId = modelId === 'zpp-x' ? 'zpp-y' : 'zpp-x';
      const other = await getModelConfig(otherId, settings);
      const switchErr = new Error(`${cfg.label} isn't responding right now. Try switching to ${other.label} (${other.tag}) from the model picker above.`);
      switchErr.suggestSwitchTo = otherId;
      throw switchErr;
    }
  }
}

/** Single attempt against one specific underlying model — no fallback
 * logic here, kept separate so streamChat() above can cleanly retry. */
async function attemptStreamChat(model, apiKey, { messages, thinking, onDelta, onReasoningDelta, signal }) {
  const res = await fetch(NVIDIA_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 1,
      top_p: 0.95,
      max_tokens: MAX_TOKENS,
      // NVIDIA's DeepSeek NIM models read this specific field to gate
      // reasoning output. Models that don't support it (e.g. GLM) simply
      // ignore an extra field they don't recognize — safe to always send.
      chat_template_kwargs: { thinking: !!thinking },
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Model unavailable (${res.status}). ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // last (possibly incomplete) line stays in the buffer

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          continue; // skip malformed/partial SSE lines
        }

        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        // Reasoning traces come back as their own field on the delta, not
        // mixed into `content` — only present when thinking=true AND the
        // underlying model actually supports/returns it.
        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          if (onReasoningDelta) onReasoningDelta(delta.reasoning_content);
        }
      }
    }
  } catch (err) {
    // Aborted (Stop button, or client disconnected) — NOT a real failure.
    // Return whatever was generated up to this point so the controller
    // can still save the partial reply, rather than losing it entirely.
    if (err.name === 'AbortError' || (signal && signal.aborted)) {
      return { content: fullContent, reasoning: fullReasoning, stopped: true };
    }
    // Mark so streamChat()'s fallback wrapper won't retry — the user has
    // already seen SOME of this reply stream in, so restarting with a
    // different model would duplicate/garble what's on screen instead of
    // cleanly recovering.
    if (fullContent) err.partiallyStreamed = true;
    throw err;
  }

  return { content: fullContent, reasoning: fullReasoning };
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  getModelConfig,
  listModels,
  buildSystemPrompt,
  streamChat,
  isAgenticSupportEnabled,
};

},

// ===== routes/sms.js =====
"routes/sms.js": function (module, exports, __r) {
const express = require('express');
const router = express.Router();
const { processIncomingSms, verifyManualUtr, confirmCheckoutPaid } = __r("controllers/smsWebhookController.js");

router.post('/webhook', processIncomingSms);
router.post('/verify-manual', verifyManualUtr); // <--- Add this line
router.post('/confirm-paid', confirmCheckoutPaid); // checkout.html -> trusted write, no re-check

module.exports = router;

},

// ===== controllers/smsWebhookController.js =====
"controllers/smsWebhookController.js": function (module, exports, __r) {
// controllers/smsWebhookController.js
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const firebaseService = __r("services/firebaseService.js");
const walletService = __r("services/walletService.js");
const fampayService = __r("services/fampayService.js");
const notificationService = __r("services/notificationService.js");
const logger = __r("utils/logger.js");

async function notifyVerifiedOrder(order, orderId, amount) {
  let title = '💰 Payment Received';
  let message = `₹${amount} credited to your wallet. Order: ${orderId}`;
  if (order.storeId && order.productId) {
    try {
      const productSnap = await ref(`${DB_PATHS.STORES}/${order.userId}/products/${order.productId}`).once('value');
      const productData = productSnap.val();
      if (productData) {
        title = '🛍️ Product Sold!';
        message = `"${productData.title || 'Product'}" sold for ₹${amount}. Order: ${orderId}`;
        await ref(`${DB_PATHS.STORES}/${order.userId}/products/${order.productId}`).update({
          salesCount: (productData.salesCount || 0) + 1,
          totalCollected: (productData.totalCollected || 0) + amount,
          lastSoldAt: Date.now(),
        });
      }
    } catch (e) {
      logger.warn(`Product stats update failed for ${orderId}: ${e.message}`);
    }
  } else if (order.linkId) {
    title = '💰 Payment Received via Link';
    message = `₹${amount} credited to your wallet. Order: ${orderId}`;
  }
  await notificationService.createNotification(order.userId, { title, message, type: 'payment' });
}

const processIncomingSms = async (req, res) => {
  try {
    const { secret, orderId, utr, status } = req.body;

    if (secret !== process.env.SMS_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorized webhook secret' });
    }

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required' });
    }

    const orderSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    if (!orderSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const targetOrder = orderSnap.val();
    if (targetOrder.status === 'success') {
      return res.status(200).json({ success: true, message: 'Order already processed' });
    }

    await firebaseService.markOrderProcessed(orderId, 'Success');
    await firebaseService.updatePaymentStatus(orderId, { 
      status: 'Success', 
      txn_id: utr || 'ONLINE_VERIFIED', 
      utr: utr || 'ONLINE_VERIFIED',
      environment: 'direct_online_webhook'
    });

    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${targetOrder.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };
    const balance = await walletService.getBalance(targetOrder.userId);
    const available = plan.walletLimit - balance;

    if (targetOrder.routingEngine !== 'cashier' && targetOrder.routingEngine !== 'system_cashier' && targetOrder.routingEngine !== 'amazon_cashier') {
      const credit = Math.min(targetOrder.amount, available);
      if (credit > 0) {
        await walletService.creditWallet(targetOrder.userId, credit, `Online Gateway Order ${orderId}`);
      }
    }

    const commissionPct = targetOrder.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((targetOrder.amount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(targetOrder.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
      }
    }

    await notifyVerifiedOrder(targetOrder, orderId, targetOrder.amount);

    logger.info(`Online Verification Success: Order ${orderId}`);
    return res.status(200).json({ success: true, message: 'Payment verified successfully' });

  } catch (error) {
    logger.error(`Webhook Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

const verifyManualUtr = async (req, res) => {
  try {
    const { orderId, utr } = req.body;

    if (!orderId || !utr || utr.length < 5) {
      return res.status(400).json({ success: false, message: 'Valid Order ID and UTR/Txn ID are required' });
    }

    const orderSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    if (!orderSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const targetOrder = orderSnap.val();
    if (targetOrder.status === 'success') {
      return res.status(200).json({ success: true, message: 'Already verified' });
    }

    const allPaymentsSnap = await ref(DB_PATHS.PAYMENTS)
      .orderByChild('utr')
      .equalTo(utr.trim())
      .once('value');
    if (allPaymentsSnap.exists()) {
      let used = false;
      allPaymentsSnap.forEach(child => {
        const p = child.val();
        if (p.status === 'success' && p.utr === utr.trim()) used = true;
      });
      if (used) {
        await firebaseService.logVerificationAttempt({
          orderId, amount: targetOrder.amount,
          utrMasked: firebaseService.maskIdentifier(utr.trim()),
          verificationMethod: 'MANUAL_UTR', verificationMode: null,
          result: 'REJECTED', reason: 'UTR/Txn ID already used for a different order',
        });
        return res.status(400).json({ success: false, message: 'This UTR/Txn ID has already been used for another order.' });
      }
    }

    const verifierForUtr = targetOrder.paymentMethod === 'amazon' ? __r("services/amazonService.js") : fampayService;
    const verified = await verifierForUtr.checkUtrForOrder(orderId, utr.trim());

    if (!verified) {
      await firebaseService.logVerificationAttempt({
        orderId, amount: targetOrder.amount,
        utrMasked: firebaseService.maskIdentifier(utr.trim()),
        verificationMethod: 'MANUAL_UTR', verificationMode: null,
        result: 'REJECTED', reason: 'No matching mailbox record found for this UTR/Txn ID within the valid window',
      });
      return res.status(400).json({ success: false, message: 'Payment not found with this UTR/Txn ID. Please check and try again.' });
    }

    await firebaseService.markOrderProcessed(orderId, 'Success');
    await firebaseService.updatePaymentStatus(orderId, { 
      status: 'Success', 
      txn_id: utr.trim(), 
      utr: utr.trim(),
      environment: 'manual_fallback'
    });

    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${targetOrder.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };
    const balance = await walletService.getBalance(targetOrder.userId);
    const available = plan.walletLimit - balance;
    
    if (targetOrder.routingEngine !== 'cashier' && targetOrder.routingEngine !== 'system_cashier' && targetOrder.routingEngine !== 'amazon_cashier') {
      const credit = Math.min(targetOrder.amount, available);
      if (credit > 0) {
        await walletService.creditWallet(targetOrder.userId, credit, `Manual Verify Order ${orderId}`);
      }
    }

    const commissionPct = targetOrder.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((targetOrder.amount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(targetOrder.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
      }
    }

    await notifyVerifiedOrder(targetOrder, orderId, targetOrder.amount);

    logger.info(`Manual verification success: Order ${orderId}, ID: ${utr}`);
    return res.status(200).json({ success: true, message: 'Verified successfully!' });

  } catch (error) {
    logger.error('Manual verification error:', error.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

/**
 * Confirm a payment that checkout.html has ALREADY verified against the
 * live mailbox itself (via verify_status.php), for the system_cashier
 * flow where checkUtrForOrder's per-merchant FamPay lookup doesn't apply
 * (system_cashier orders aren't tied to one user's connected mailbox).
 * This performs the exact same DB write / wallet credit / commission /
 * notification steps as verifyManualUtr — it just skips re-querying the
 * mailbox a second time, since checkout.html already did that check and
 * is reporting a confirmed result, not a user-typed guess.
 */
const confirmCheckoutPaid = async (req, res) => {
  try {
    const { orderId, utr } = req.body;

    if (!orderId || !utr || String(utr).length < 3) {
      return res.status(400).json({ success: false, message: 'Valid Order ID and UTR/Txn ID are required' });
    }

    const orderSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    if (!orderSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const targetOrder = orderSnap.val();
    if (targetOrder.status === 'success') {
      return res.status(200).json({ success: true, message: 'Already verified' });
    }

    const utrTrimmed = String(utr).trim();

    const allPaymentsSnap = await ref(DB_PATHS.PAYMENTS)
      .orderByChild('utr')
      .equalTo(utrTrimmed)
      .once('value');
    if (allPaymentsSnap.exists()) {
      let used = false;
      allPaymentsSnap.forEach(child => {
        const p = child.val();
        if (p.status === 'success' && p.utr === utrTrimmed) used = true;
      });
      if (used) {
        return res.status(400).json({ success: false, message: 'This UTR/Txn ID has already been used for another order.' });
      }
    }

    await firebaseService.markOrderProcessed(orderId, 'Success');
    await firebaseService.updatePaymentStatus(orderId, {
      status: 'Success',
      txn_id: utrTrimmed,
      utr: utrTrimmed,
      environment: 'checkout_confirmed'
    });

    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${targetOrder.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };
    const balance = await walletService.getBalance(targetOrder.userId);
    const available = plan.walletLimit - balance;

    if (targetOrder.routingEngine !== 'cashier' && targetOrder.routingEngine !== 'system_cashier' && targetOrder.routingEngine !== 'amazon_cashier') {
      const credit = Math.min(targetOrder.amount, available);
      if (credit > 0) {
        await walletService.creditWallet(targetOrder.userId, credit, `Checkout Confirmed Order ${orderId}`);
      }
    }

    const commissionPct = targetOrder.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((targetOrder.amount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(targetOrder.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for checkout-confirmed order ${orderId}: ${e.message}`);
      }
    }

    await notifyVerifiedOrder(targetOrder, orderId, targetOrder.amount);

    logger.info(`Checkout-confirmed payment: Order ${orderId}, UTR: ${utrTrimmed}`);
    return res.status(200).json({ success: true, message: 'Order confirmed', order_id: orderId, status: 'success' });

  } catch (error) {
    logger.error('Confirm checkout paid error:', error.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

module.exports = { processIncomingSms, verifyManualUtr, confirmCheckoutPaid };

},

// ===== routes/fampay.js =====
"routes/fampay.js": function (module, exports, __r) {
// routes/fampay.js
const express = require('express');
const router = express.Router();
const fampayController = __r("controllers/fampayController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");

// Multi-account endpoints
router.get('/accounts', authenticate, blockIfBanned, fampayController.getFampayAccounts);
router.post('/accounts/add', authenticate, blockIfBanned, fampayController.addFampayAccountBasic);
router.post('/accounts/verify', authenticate, blockIfBanned, fampayController.verifyFampayAccount);
router.post('/accounts/activate', authenticate, blockIfBanned, fampayController.setActiveFampayAccount);
router.post('/accounts/remove', authenticate, blockIfBanned, fampayController.removeFampayAccount);

// Legacy single-account endpoints (kept for rolling-deploy safety)
router.get('/status', authenticate, blockIfBanned, fampayController.getFampayStatus);
router.post('/disconnect', authenticate, blockIfBanned, fampayController.disconnectFampay);

// Live email history fetch karne ke liye naya route
router.get('/history', authenticate, blockIfBanned, fampayController.getHistory);

module.exports = router;

},

// ===== controllers/fampayController.js =====
"controllers/fampayController.js": function (module, exports, __r) {
// controllers/fampayController.js
//
// Multi-account FamPay Connect: a merchant can save up to 3 FamPay
// accounts (each with its own phone/UPI ID/Gmail/app-password), see them
// in a list with a 4-digit cashier ID and Active/Inactive status, and
// toggle exactly one as the account actually used for checkout.
//
// Storage shape: user.fampayAccounts = { <cashierId>: { upiId, mobile,
// email, password (encrypted), isVerified, isActive, createdAt } }
//
// IMPORTANT — backward compatibility: every payment-routing controller
// across the codebase (paymentController, paymentLinkController,
// storeController, storePublicController, developerController,
// adminController, fampayService) reads a single user.fampay object
// directly and has no awareness of accounts/lists. Rather than touching
// all of those call sites, this controller keeps user.fampay mirrored to
// whichever account in fampayAccounts is currently isActive — so
// switching the active account here transparently changes what every one
// of those existing routes uses, with zero changes needed there.
const encryption = __r("utils/encryption.js");
const response = __r("helpers/response.js");
const firebaseService = __r("services/firebaseService.js");
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");
const { fetchFamPayHistory } = __r("controllers/historyController.js");

const MAX_ACCOUNTS = 3;

// Both callers of fetchFamPayHistory below (step-2 verify, and the
// Live Email History sync) used to call out to the legacy
// https://YOUR-DOMAIN.com/history.php PHP endpoint via axios with NO
// timeout configured at all — if that remote server (or the IMAP
// connection it was making) ever hung, the request to OUR backend hung
// right along with it, forever, which is exactly the infinite
// "Verifying..." / "Reading emails securely... Please wait" spinners
// this was causing. fetchFamPayHistory() is the same in-process,
// already-hardened IMAP fetcher services/fampayService.js uses for
// live payment verification — no external PHP hop, and wrapped here in
// a hard ceiling so a stuck IMAP connection can never hang this
// endpoint indefinitely either.
const IMAP_CALL_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

// 4-digit numeric id, unique within this merchant's own account list —
// short enough to read at a glance (matches the "440" / "2700" style ids
// in the competitor screenshot), collision-checked against what this
// merchant already has rather than being globally unique (no need for
// that — these ids are only ever looked up scoped to one merchant).
function generateCashierId(existingIds) {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (existingIds.includes(id));
  return id;
}

// Re-applies whichever account is isActive (if any) onto user.fampay —
// the single-object mirror every other controller reads. Called after
// every mutation (add/verify/toggle/remove) so that mirror never drifts
// from the account list's own idea of what's active.
async function syncActiveAccountToLegacyField(uid, accounts) {
  const activeEntry = Object.entries(accounts || {}).find(([, acc]) => acc.isActive);

  if (!activeEntry) {
    await ref(`${DB_PATHS.USERS}/${uid}/fampay`).remove();
    await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'wallet' });
    return;
  }

  const [, acc] = activeEntry;
  await ref(`${DB_PATHS.USERS}/${uid}/fampay`).set({
    upiId: acc.upiId,
    email: acc.email,
    password: acc.password,
    mobile: acc.mobile,
    isConnected: true,
    connectedAt: acc.createdAt,
  });
  await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'cashier' });
}

// One-time backward migration: a merchant who connected FamPay BEFORE
// multi-account support existed only has legacy user.fampay populated —
// fampayAccounts would be empty even though they genuinely have a
// working, verified connection. Rather than making that account
// invisible in the new list UI (and implicitly asking them to
// re-verify something that already works), fold it into fampayAccounts
// as a real, already-active, already-verified entry the first time this
// is read after the update. Runs at most once per merchant — after this,
// fampayAccounts is non-empty and this branch never runs again for them.
async function migrateLegacyFampayIfNeeded(uid, user) {
  const hasAccounts = user?.fampayAccounts && Object.keys(user.fampayAccounts).length > 0;
  if (hasAccounts) return user.fampayAccounts;
  if (!user?.fampay || !user.fampay.isConnected) return {};

  const cashierId = generateCashierId([]);
  const migrated = {
    upiId: user.fampay.upiId || '',
    mobile: user.fampay.mobile || '',
    email: user.fampay.email || null,
    password: user.fampay.password || null, // already encrypted — carried over as-is, not re-encrypted
    isVerified: true, // it was working under the old single-account system, so it already passed a real Gmail check
    isActive: true,
    createdAt: user.fampay.connectedAt || Date.now(),
  };
  await ref(`${DB_PATHS.USERS}/${uid}/fampayAccounts/${cashierId}`).set(migrated);
  return { [cashierId]: migrated };
}

const getFampayAccounts = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    const accounts = await migrateLegacyFampayIfNeeded(req.user.uid, user);

    const list = Object.entries(accounts).map(([cashierId, acc]) => ({
      cashierId,
      upiId: acc.upiId,
      mobile: acc.mobile,
      email: acc.email,
      isVerified: !!acc.isVerified,
      isActive: !!acc.isActive,
      createdAt: acc.createdAt,
      // Password is intentionally never sent back to the frontend.
    })).sort((a, b) => a.createdAt - b.createdAt);

    return response.success(res, 'FamPay accounts fetched', {
      accounts: list,
      maxAccounts: MAX_ACCOUNTS,
      canAddMore: list.length < MAX_ACCOUNTS,
    });
  } catch (err) {
    logger.error('Get FamPay Accounts Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Step 1 of the add-account popup: phone + UPI ID only, no verification
// yet. Saved immediately as isVerified:false / isActive:false — the
// account shows up in the list right away (Status: Inactive) even if the
// user abandons step 2, rather than silently losing what they entered.
const addFampayAccountBasic = async (req, res) => {
  try {
    const { upiId, mobile } = req.body;
    if (!upiId || !mobile) {
      return response.error(res, 'UPI ID and mobile number are required', 400);
    }
    if (!/^[\w.\-]+@fam$/i.test(upiId.trim())) {
      return response.error(res, 'FamPay UPI ID should look like username@fam', 400);
    }
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      return response.error(res, 'Enter a valid 10-digit mobile number', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.fampayAccounts || {};
    const existingIds = Object.keys(accounts);

    if (existingIds.length >= MAX_ACCOUNTS) {
      return response.error(res, `You can connect up to ${MAX_ACCOUNTS} FamPay accounts. Remove one before adding another.`, 400);
    }

    const cashierId = generateCashierId(existingIds);
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampayAccounts/${cashierId}`).set({
      upiId: upiId.trim(),
      mobile: mobile.trim(),
      email: null,
      password: null,
      isVerified: false,
      isActive: false,
      createdAt: Date.now(),
    });

    return response.success(res, 'Account created — now verify your Gmail to activate it', { cashierId });
  } catch (err) {
    logger.error('Add FamPay Account (basic) Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Step 2: Gmail + app password, verified against history.php the same
// way the old single-account connectFampay did. On success this marks
// the account isVerified:true — it still isn't necessarily the ACTIVE
// one (that's a separate, explicit toggle) unless this is the merchant's
// first-ever verified account, in which case it's activated automatically
// so a brand-new merchant doesn't have to know to flip a switch just to
// get their first account working.
const verifyFampayAccount = async (req, res) => {
  try {
    const { cashierId, email, password } = req.body;
    if (!cashierId || !email || !password) {
      return response.error(res, 'Email and App Password are required', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.fampayAccounts || {};
    if (!accounts[cashierId]) {
      return response.error(res, 'Account not found', 404);
    }

    let result;
    try {
      result = await withTimeout(
        fetchFamPayHistory(email, password, 1),
        IMAP_CALL_TIMEOUT_MS,
        'Gmail took too long to respond. Please try again in a moment.'
      );
    } catch (timeoutErr) {
      return response.error(res, timeoutErr.message, 408);
    }
    if (!result || !result.status) {
      const detail = (result && result.error) || 'IMAP Auth failed.';
      return response.error(res, 'Invalid Email or App Password: ' + detail, 400);
    }

    const encryptedPassword = encryption.encrypt(password);
    const hasAnyVerifiedAccount = Object.values(accounts).some(acc => acc.isVerified);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampayAccounts/${cashierId}`).update({
      email,
      password: encryptedPassword,
      isVerified: true,
      // First verified account for this merchant auto-activates; if they
      // already have one active, leave activation to the explicit toggle
      // below so verifying a 2nd/3rd account never silently switches
      // which one checkout is using.
      isActive: hasAnyVerifiedAccount ? !!accounts[cashierId].isActive : true,
    });

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.fampayAccounts || {});

    return response.success(res, 'FamPay account verified successfully');
  } catch (err) {
    logger.error('Verify FamPay Account Error:', err.message);
    return response.serverError(res, 'Verification failed: ' + err.message);
  }
};

// Explicit single-active toggle — activating one account deactivates
// every other one for this merchant, enforced server-side (not just left
// to the frontend) since this directly controls which inbox real
// payments get verified against.
const setActiveFampayAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.fampayAccounts || {};
    if (!accounts[cashierId]) return response.error(res, 'Account not found', 404);
    if (!accounts[cashierId].isVerified) {
      return response.error(res, 'Verify this account (connect Gmail) before activating it.', 400);
    }

    const updates = {};
    Object.keys(accounts).forEach(id => {
      updates[`fampayAccounts/${id}/isActive`] = (id === cashierId);
    });
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update(updates);

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.fampayAccounts || {});

    return response.success(res, 'Active FamPay account updated');
  } catch (err) {
    logger.error('Set Active FamPay Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const removeFampayAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampayAccounts/${cashierId}`).remove();

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.fampayAccounts || {});
    await firebaseService.logActivity(req.user.uid, 'FAMPAY_ACCOUNT_REMOVED', { cashierId });

    return response.success(res, 'Account removed');
  } catch (err) {
    logger.error('Remove FamPay Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// ── Legacy single-account endpoints, kept working ──
// Some older frontend builds (or this same page mid-deploy) may still
// call /status, /connect, /disconnect directly. /status now reads the
// active account out of the new list; /connect and /disconnect are
// thin wrappers so nothing 404s during a rolling deploy.
const getFampayStatus = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (user && user.fampay && user.fampay.isConnected) {
      return response.success(res, 'FamPay is connected', {
        isConnected: true,
        upiId: user.fampay.upiId,
        email: user.fampay.email,
        mobile: user.fampay.mobile
      });
    }

    return response.success(res, 'FamPay is disconnected', { isConnected: false });
  } catch (err) {
    logger.error('Get FamPay Status Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disconnectFampay = async (req, res) => {
  try {
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampay`).remove();
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: 'wallet' });
    await firebaseService.logActivity(req.user.uid, 'FAMPAY_DISCONNECTED', { routingResetTo: 'wallet' });
    return response.success(res, 'FamPay disconnected successfully');
  } catch (err) {
    logger.error('Disconnect FamPay Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getHistory = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (!user || !user.fampay || !user.fampay.isConnected) {
      return response.error(res, 'FamPay is not connected. Please connect first.', 400);
    }

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) {
      return response.error(res, 'Failed to decrypt app password. Please reconnect FamPay.', 400);
    }

    let result;
    try {
      result = await withTimeout(
        fetchFamPayHistory(user.fampay.email, rawPassword, 15),
        IMAP_CALL_TIMEOUT_MS,
        'Gmail took too long to respond. Please try again in a moment.'
      );
    } catch (timeoutErr) {
      return response.error(res, timeoutErr.message, 408);
    }

    if (!result || !result.status) {
      return response.error(res, result?.error || 'Failed to fetch emails from server.', 400);
    }

    return response.success(res, 'History fetched', result.data);
  } catch (err) {
    logger.error('Fetch History Error:', err.message);
    return response.serverError(res, 'Error fetching history: ' + err.message);
  }
};

module.exports = {
  getFampayAccounts,
  addFampayAccountBasic,
  verifyFampayAccount,
  setActiveFampayAccount,
  removeFampayAccount,
  getFampayStatus,
  disconnectFampay,
  getHistory,
};

},

// ===== routes/paytm.js =====
"routes/paytm.js": function (module, exports, __r) {
// routes/paytm.js
const express = require('express');
const router = express.Router();
const paytmController = __r("controllers/paytmController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");

// Multi-account endpoints
router.get('/accounts', authenticate, blockIfBanned, paytmController.getPaytmAccounts);
router.post('/accounts/add', authenticate, blockIfBanned, paytmController.addPaytmAccountBasic);
router.post('/accounts/verify', authenticate, blockIfBanned, paytmController.verifyPaytmAccount);
router.post('/accounts/activate', authenticate, blockIfBanned, paytmController.setActivePaytmAccount);
router.post('/accounts/remove', authenticate, blockIfBanned, paytmController.removePaytmAccount);

// Legacy single-account endpoints (kept for rolling-deploy safety)
router.get('/status', authenticate, blockIfBanned, paytmController.getPaytmStatus);
router.post('/disconnect', authenticate, blockIfBanned, paytmController.disconnectPaytm);

module.exports = router;

},

// ===== controllers/paytmController.js =====
"controllers/paytmController.js": function (module, exports, __r) {
// controllers/paytmController.js
//
// Multi-account Paytm Connect — same shape as the multi-account
// fampayController.js: up to 3 saved accounts, 4-digit cashier ids,
// Active/Inactive status, one explicit active toggle. See
// fampayController.js's header comment for the full rationale on why
// user.paytm is kept mirrored to the active account rather than updating
// every payment-routing controller to understand a list.
//
// Storage shape: user.paytmAccounts = { <cashierId>: { mid (encrypted),
// upiId, mobile, isVerified, isActive, createdAt } }
const axios = require('axios');
const encryption = __r("utils/encryption.js");
const response = __r("helpers/response.js");
const firebaseService = __r("services/firebaseService.js");
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");

const PAYTM_STATUS_URL = 'https://securegw.paytm.in/order/status';
const MAX_ACCOUNTS = 3;
const MID_PATTERN = /^[A-Za-z0-9]{6,20}$/;

function generateCashierId(existingIds) {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (existingIds.includes(id));
  return id;
}

async function syncActiveAccountToLegacyField(uid, accounts) {
  const activeEntry = Object.entries(accounts || {}).find(([, acc]) => acc.isActive);

  if (!activeEntry) {
    await ref(`${DB_PATHS.USERS}/${uid}/paytm`).remove();
    await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'wallet' });
    return;
  }

  const [, acc] = activeEntry;
  await ref(`${DB_PATHS.USERS}/${uid}/paytm`).set({
    mid: acc.mid,
    upiId: acc.upiId,
    mobile: acc.mobile,
    isConnected: true,
    connectedAt: acc.createdAt,
  });
  await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'paytm_cashier' });
}

async function probeMid(mid) {
  const probeRes = await axios.get(PAYTM_STATUS_URL, {
    params: { JsonData: JSON.stringify({ MID: mid, ORDERID: 'ZAPPAY_CONNECT_PROBE' }) },
    timeout: 8000,
  });
  if (!probeRes.data || typeof probeRes.data !== 'object' || !probeRes.data.MID) return false;
  return probeRes.data.MID === mid;
}

// One-time backward migration — see fampayController.js's identical
// function for the full rationale. A merchant who connected Paytm via
// the old single-account flow only has user.paytm populated; fold it
// into paytmAccounts as an already-active, already-verified entry the
// first time this is read post-update.
async function migrateLegacyPaytmIfNeeded(uid, user) {
  const hasAccounts = user?.paytmAccounts && Object.keys(user.paytmAccounts).length > 0;
  if (hasAccounts) return user.paytmAccounts;
  if (!user?.paytm || !user.paytm.isConnected) return {};

  const cashierId = generateCashierId([]);
  const migrated = {
    upiId: user.paytm.upiId || '',
    mobile: user.paytm.mobile || '',
    mid: user.paytm.mid || null, // already encrypted — carried over as-is
    isVerified: true,
    isActive: true,
    createdAt: user.paytm.connectedAt || Date.now(),
  };
  await ref(`${DB_PATHS.USERS}/${uid}/paytmAccounts/${cashierId}`).set(migrated);
  return { [cashierId]: migrated };
}

const getPaytmAccounts = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    const accounts = await migrateLegacyPaytmIfNeeded(req.user.uid, user);

    const list = Object.entries(accounts).map(([cashierId, acc]) => ({
      cashierId,
      upiId: acc.upiId,
      mobile: acc.mobile,
      isVerified: !!acc.isVerified,
      isActive: !!acc.isActive,
      createdAt: acc.createdAt,
    })).sort((a, b) => a.createdAt - b.createdAt);

    return response.success(res, 'Paytm accounts fetched', {
      accounts: list,
      maxAccounts: MAX_ACCOUNTS,
      canAddMore: list.length < MAX_ACCOUNTS,
    });
  } catch (err) {
    logger.error('Get Paytm Accounts Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const addPaytmAccountBasic = async (req, res) => {
  try {
    const { upiId, mobile } = req.body;
    if (!upiId || !mobile) {
      return response.error(res, 'UPI ID and mobile number are required', 400);
    }
    if (!/^[\w.\-]+@\w+$/i.test(upiId.trim())) {
      return response.error(res, 'Enter a valid UPI ID (e.g. name@paytm)', 400);
    }
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      return response.error(res, 'Enter a valid 10-digit mobile number', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.paytmAccounts || {};
    const existingIds = Object.keys(accounts);

    if (existingIds.length >= MAX_ACCOUNTS) {
      return response.error(res, `You can connect up to ${MAX_ACCOUNTS} Paytm accounts. Remove one before adding another.`, 400);
    }

    const cashierId = generateCashierId(existingIds);
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytmAccounts/${cashierId}`).set({
      upiId: upiId.trim(),
      mobile: mobile.trim(),
      mid: null,
      isVerified: false,
      isActive: false,
      createdAt: Date.now(),
    });

    return response.success(res, 'Account created — now verify your Merchant ID to activate it', { cashierId });
  } catch (err) {
    logger.error('Add Paytm Account (basic) Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const verifyPaytmAccount = async (req, res) => {
  try {
    const { cashierId, mid } = req.body;
    if (!cashierId || !mid) {
      return response.error(res, 'Merchant ID is required', 400);
    }
    if (!MID_PATTERN.test(mid.trim())) {
      return response.error(res, 'Merchant ID looks invalid — check it against your Paytm Business Dashboard.', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.paytmAccounts || {};
    if (!accounts[cashierId]) {
      return response.error(res, 'Account not found', 404);
    }

    let midOk;
    try {
      midOk = await probeMid(mid.trim());
    } catch (probeErr) {
      logger.error('Paytm MID probe failed:', probeErr.message);
      return response.error(res, 'Could not reach Paytm to verify this Merchant ID. Please try again shortly.', 400);
    }
    if (!midOk) {
      return response.error(res, 'Could not verify this Merchant ID with Paytm. Double-check it and try again.', 400);
    }

    const encryptedMid = encryption.encrypt(mid.trim());
    const hasAnyVerifiedAccount = Object.values(accounts).some(acc => acc.isVerified);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytmAccounts/${cashierId}`).update({
      mid: encryptedMid,
      isVerified: true,
      isActive: hasAnyVerifiedAccount ? !!accounts[cashierId].isActive : true,
    });

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.paytmAccounts || {});

    return response.success(res, 'Paytm account verified successfully');
  } catch (err) {
    logger.error('Verify Paytm Account Error:', err.message);
    return response.serverError(res, 'Verification failed: ' + err.message);
  }
};

const setActivePaytmAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.paytmAccounts || {};
    if (!accounts[cashierId]) return response.error(res, 'Account not found', 404);
    if (!accounts[cashierId].isVerified) {
      return response.error(res, 'Verify this account (confirm Merchant ID) before activating it.', 400);
    }

    const updates = {};
    Object.keys(accounts).forEach(id => {
      updates[`paytmAccounts/${id}/isActive`] = (id === cashierId);
    });
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update(updates);

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.paytmAccounts || {});

    return response.success(res, 'Active Paytm account updated');
  } catch (err) {
    logger.error('Set Active Paytm Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const removePaytmAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytmAccounts/${cashierId}`).remove();

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.paytmAccounts || {});
    await firebaseService.logActivity(req.user.uid, 'PAYTM_ACCOUNT_REMOVED', { cashierId });

    return response.success(res, 'Account removed');
  } catch (err) {
    logger.error('Remove Paytm Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getPaytmStatus = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (user && user.paytm && user.paytm.isConnected) {
      return response.success(res, 'Paytm is connected', {
        isConnected: true,
        upiId: user.paytm.upiId,
        mobile: user.paytm.mobile,
      });
    }

    return response.success(res, 'Paytm is disconnected', { isConnected: false });
  } catch (err) {
    logger.error('Get Paytm Status Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disconnectPaytm = async (req, res) => {
  try {
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytm`).remove();
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: 'wallet' });
    await firebaseService.logActivity(req.user.uid, 'PAYTM_DISCONNECTED', { routingResetTo: 'wallet' });
    return response.success(res, 'Paytm disconnected successfully');
  } catch (err) {
    logger.error('Disconnect Paytm Error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getPaytmAccounts,
  addPaytmAccountBasic,
  verifyPaytmAccount,
  setActivePaytmAccount,
  removePaytmAccount,
  getPaytmStatus,
  disconnectPaytm,
};

},

// ===== routes/amazon.js =====
"routes/amazon.js": function (module, exports, __r) {
// routes/amazon.js
const express = require('express');
const router = express.Router();
const amazonController = __r("controllers/amazonController.js");
const { authenticate, blockIfBanned } = __r("middleware/auth.js");

// Multi-account endpoints (same shape as /api/fampay and /api/paytm)
router.get('/accounts', authenticate, blockIfBanned, amazonController.getAmazonAccounts);
router.post('/accounts/add', authenticate, blockIfBanned, amazonController.addAmazonAccountBasic);
router.post('/accounts/verify', authenticate, blockIfBanned, amazonController.verifyAmazonAccount);
router.post('/accounts/activate', authenticate, blockIfBanned, amazonController.setActiveAmazonAccount);
router.post('/accounts/remove', authenticate, blockIfBanned, amazonController.removeAmazonAccount);

router.get('/status', authenticate, blockIfBanned, amazonController.getAmazonStatus);
router.post('/disconnect', authenticate, blockIfBanned, amazonController.disconnectAmazon);

// Live email history
router.get('/history', authenticate, blockIfBanned, amazonController.getHistory);

module.exports = router;

},

// ===== controllers/amazonController.js =====
"controllers/amazonController.js": function (module, exports, __r) {
// controllers/amazonController.js
//
// Multi-account Amazon Pay Connect — the counterpart of fampayController.
// A merchant saves up to 3 Amazon Pay accounts (each: Amazon Pay UPI ID,
// mobile, Gmail + App Password), sees them with a 4-digit cashier ID and
// Active/Inactive status, and toggles exactly one as the account checkout
// uses.
//
// Storage: user.amazonAccounts = { <cashierId>: { upiId, mobile, email,
// password (encrypted), isVerified, isActive, createdAt } }
//
// Like FamPay/Paytm, the single active account is mirrored to user.amazon
// (the object every payment-routing controller reads) and routing is
// switched to 'amazon_cashier'.
const encryption = __r("utils/encryption.js");
const response = __r("helpers/response.js");
const firebaseService = __r("services/firebaseService.js");
const { ref } = __r("firebase/admin.js");
const { DB_PATHS } = __r("config/constants.js");
const logger = __r("utils/logger.js");
const { fetchAmazonHistory } = __r("controllers/historyController.js");

const MAX_ACCOUNTS = 3;
const IMAP_CALL_TIMEOUT_MS = 20000;
const ENGINE = 'amazon_cashier';

function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

function generateCashierId(existingIds) {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (existingIds.includes(id));
  return id;
}

// Mirrors the active account onto user.amazon. When `switchRouting` is
// true (verify / activate) routing moves to Amazon; when the last active
// account disappears, routing falls back to 'wallet' ONLY if Amazon was
// the engine in use — removing an Amazon account must never knock a
// merchant off FamPay or Paytm.
async function syncActiveAccountToLegacyField(uid, accounts, switchRouting) {
  const activeEntry = Object.entries(accounts || {}).find(([, acc]) => acc.isActive);

  if (!activeEntry) {
    await ref(`${DB_PATHS.USERS}/${uid}/amazon`).remove();
    const user = await firebaseService.getUser(uid);
    if (user?.apiRoutingEngine === ENGINE) {
      await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'wallet' });
    }
    return;
  }

  const [, acc] = activeEntry;
  await ref(`${DB_PATHS.USERS}/${uid}/amazon`).set({
    upiId: acc.upiId,
    email: acc.email,
    password: acc.password,
    mobile: acc.mobile,
    isConnected: true,
    connectedAt: acc.createdAt,
  });
  if (switchRouting) {
    await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: ENGINE });
  }
}

const getAmazonAccounts = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.amazonAccounts || {};

    const list = Object.entries(accounts).map(([cashierId, acc]) => ({
      cashierId,
      upiId: acc.upiId,
      mobile: acc.mobile,
      email: acc.email,
      isVerified: !!acc.isVerified,
      isActive: !!acc.isActive,
      createdAt: acc.createdAt,
      // Password is intentionally never sent back to the frontend.
    })).sort((a, b) => a.createdAt - b.createdAt);

    return response.success(res, 'Amazon Pay accounts fetched', {
      accounts: list,
      maxAccounts: MAX_ACCOUNTS,
      canAddMore: list.length < MAX_ACCOUNTS,
    });
  } catch (err) {
    logger.error('Get Amazon Accounts Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Step 1: Amazon Pay UPI ID + mobile only. Saved immediately as
// Inactive / unverified.
const addAmazonAccountBasic = async (req, res) => {
  try {
    const { upiId, mobile } = req.body;
    if (!upiId || !mobile) {
      return response.error(res, 'UPI ID and mobile number are required', 400);
    }
    if (!/^[\w.\-]{2,}@[a-z][a-z0-9]{1,}$/i.test(upiId.trim())) {
      return response.error(res, 'Amazon Pay UPI ID should look like 9876543210@apl', 400);
    }
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      return response.error(res, 'Enter a valid 10-digit mobile number', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.amazonAccounts || {};
    const existingIds = Object.keys(accounts);

    if (existingIds.length >= MAX_ACCOUNTS) {
      return response.error(res, `You can connect up to ${MAX_ACCOUNTS} Amazon Pay accounts. Remove one before adding another.`, 400);
    }

    const cashierId = generateCashierId(existingIds);
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/amazonAccounts/${cashierId}`).set({
      upiId: upiId.trim(),
      mobile: mobile.trim(),
      email: null,
      password: null,
      isVerified: false,
      isActive: false,
      createdAt: Date.now(),
    });

    return response.success(res, 'Account created — now verify your Gmail to activate it', { cashierId });
  } catch (err) {
    logger.error('Add Amazon Account (basic) Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Step 2: Gmail + App Password, checked with a real IMAP login. The
// merchant's first verified account auto-activates.
const verifyAmazonAccount = async (req, res) => {
  try {
    const { cashierId, email, password } = req.body;
    if (!cashierId || !email || !password) {
      return response.error(res, 'Email and App Password are required', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.amazonAccounts || {};
    if (!accounts[cashierId]) {
      return response.error(res, 'Account not found', 404);
    }

    let result;
    try {
      result = await withTimeout(
        fetchAmazonHistory(email, password, 1),
        IMAP_CALL_TIMEOUT_MS,
        'Gmail took too long to respond. Please try again in a moment.'
      );
    } catch (timeoutErr) {
      return response.error(res, timeoutErr.message, 408);
    }
    if (!result || !result.status) {
      const detail = (result && result.error) || 'IMAP Auth failed.';
      return response.error(res, 'Invalid Email or App Password: ' + detail, 400);
    }

    const encryptedPassword = encryption.encrypt(password);
    const hasAnyVerifiedAccount = Object.values(accounts).some(acc => acc.isVerified);
    const willBeActive = hasAnyVerifiedAccount ? !!accounts[cashierId].isActive : true;

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/amazonAccounts/${cashierId}`).update({
      email,
      password: encryptedPassword,
      isVerified: true,
      isActive: willBeActive,
    });

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.amazonAccounts || {}, willBeActive);

    return response.success(res, 'Amazon Pay account verified successfully');
  } catch (err) {
    logger.error('Verify Amazon Account Error:', err.message);
    return response.serverError(res, 'Verification failed: ' + err.message);
  }
};

// Explicit single-active toggle, enforced server-side.
const setActiveAmazonAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.amazonAccounts || {};
    if (!accounts[cashierId]) return response.error(res, 'Account not found', 404);
    if (!accounts[cashierId].isVerified) {
      return response.error(res, 'Verify this account (connect Gmail) before activating it.', 400);
    }

    const updates = {};
    Object.keys(accounts).forEach(id => {
      updates[`amazonAccounts/${id}/isActive`] = (id === cashierId);
    });
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update(updates);

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.amazonAccounts || {}, true);

    return response.success(res, 'Active Amazon Pay account updated');
  } catch (err) {
    logger.error('Set Active Amazon Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const removeAmazonAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/amazonAccounts/${cashierId}`).remove();

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.amazonAccounts || {}, false);
    await firebaseService.logActivity(req.user.uid, 'AMAZON_ACCOUNT_REMOVED', { cashierId });

    return response.success(res, 'Account removed');
  } catch (err) {
    logger.error('Remove Amazon Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getAmazonStatus = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (user && user.amazon && user.amazon.isConnected) {
      return response.success(res, 'Amazon Pay is connected', {
        isConnected: true,
        upiId: user.amazon.upiId,
        email: user.amazon.email,
        mobile: user.amazon.mobile,
      });
    }

    return response.success(res, 'Amazon Pay is disconnected', { isConnected: false });
  } catch (err) {
    logger.error('Get Amazon Status Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disconnectAmazon = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/amazon`).remove();
    if (user?.apiRoutingEngine === ENGINE) {
      await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: 'wallet' });
    }
    await firebaseService.logActivity(req.user.uid, 'AMAZON_DISCONNECTED', { routingResetTo: 'wallet' });
    return response.success(res, 'Amazon Pay disconnected successfully');
  } catch (err) {
    logger.error('Disconnect Amazon Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Live Email History for the Amazon Connect page.
const getHistory = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (!user || !user.amazon || !user.amazon.isConnected) {
      return response.error(res, 'Amazon Pay is not connected. Please connect first.', 400);
    }

    const rawPassword = encryption.decrypt(user.amazon.password);
    if (!rawPassword) {
      return response.error(res, 'Failed to decrypt app password. Please reconnect Amazon Pay.', 400);
    }

    let result;
    try {
      result = await withTimeout(
        fetchAmazonHistory(user.amazon.email, rawPassword, 15),
        IMAP_CALL_TIMEOUT_MS,
        'Gmail took too long to respond. Please try again in a moment.'
      );
    } catch (timeoutErr) {
      return response.error(res, timeoutErr.message, 408);
    }

    if (!result || !result.status) {
      return response.error(res, result?.error || 'Failed to fetch emails from server.', 400);
    }

    return response.success(res, 'History fetched', result.data);
  } catch (err) {
    logger.error('Fetch Amazon History Error:', err.message);
    return response.serverError(res, 'Error fetching history: ' + err.message);
  }
};

module.exports = {
  getAmazonAccounts,
  addAmazonAccountBasic,
  verifyAmazonAccount,
  setActiveAmazonAccount,
  removeAmazonAccount,
  getAmazonStatus,
  disconnectAmazon,
  getHistory,
};

},

// ===== routes/history.js =====
"routes/history.js": function (module, exports, __r) {
const express = require('express');
const router = express.Router();
const { fetchHistory } = __r("controllers/historyController.js");
const { authenticate } = __r("middleware/auth.js"); // Import auth

// Ab ye route check karega ki user logged in hai ya nahi
router.post('/fetch', authenticate, fetchHistory);

module.exports = router;

},

// ===== routes/cron.js =====
"routes/cron.js": function (module, exports, __r) {
// routes/cron.js
//
// Scheduled background jobs, triggered by Vercel Cron (see vercel.json's
// "crons" entry) rather than by any user action. Vercel Cron calls these
// as plain HTTP GET requests on a schedule — there's no logged-in user
// making the request, so authentication here is a shared secret
// (CRON_SECRET) instead of the normal JWT middleware, same idea as
// SMS_WEBHOOK_SECRET for the SMS webhook.
const express = require('express');
const router = express.Router();
const firebaseService = __r("services/firebaseService.js");
const paytmService = __r("services/paytmService.js");
const fampayService = __r("services/fampayService.js");
const logger = __r("utils/logger.js");

function requireCronSecret(req, res, next) {
  const provided = req.headers['authorization']?.replace('Bearer ', '') || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

/**
 * GET /api/cron/verify-paytm-orders
 *
 * Re-checks every still-pending Paytm-routed order against Paytm's own
 * order-status API. This is the fix for Paytm orders that never got
 * verified because verification previously only ran when a customer's
 * own browser polled the checkout page (see getPublicOrderStatus in
 * developerController.js, and getLinkOrderStatus in
 * paymentLinkController.js, for that original trigger point) — if the
 * customer closed the tab, lost connection, or the page never finished
 * loading, the order stayed 'pending' forever even though Paytm had
 * genuinely received the payment. Running this on a schedule means a
 * pending Paytm order gets checked regardless of what the customer's
 * browser does after paying.
 *
 * Safe to run frequently and concurrently with a customer's own poll —
 * paytmService.verifyPayment() already contains its own idempotency
 * (the payments/{orderId} transaction only ever fires once), so this
 * cron and a live user poll racing on the same order just means
 * whichever gets there first wins; the other sees status !== 'pending'
 * and no-ops.
 */
router.get('/verify-paytm-orders', requireCronSecret, async (req, res) => {
  try {
    const pending = await firebaseService.getPendingPaytmOrders();
    logger.info(`[cron] verify-paytm-orders: checking ${pending.length} pending order(s)`);

    let verified = 0;
    let stillPending = 0;
    let errored = 0;

    // Sequential, not Promise.all — this hits Paytm's live API once per
    // order, and there's no urgency here (it's a periodic sweep, not a
    // user waiting on a response), so there's no reason to burst dozens
    // of concurrent requests at Paytm and risk rate-limiting the account
    // this MID belongs to.
    for (const order of pending) {
      try {
        const result = await paytmService.verifyPayment(order.orderId);
        if (result) verified++;
        else stillPending++;
      } catch (e) {
        errored++;
        logger.warn(`[cron] verify-paytm-orders: order ${order.orderId} failed: ${e.message}`);
      }
    }

    logger.info(`[cron] verify-paytm-orders done: ${verified} verified, ${stillPending} still pending, ${errored} errored`);

    // ─── FamPay late-reconciliation sweep, same cron run ───────────────
    // Folded into this SAME endpoint/invocation rather than a separate
    // route: Vercel's Hobby plan allows only 1 cron schedule, already
    // spent on this one (see vercel.json). See
    // firebaseService.getRecentlyCancelledFampayOrders and
    // fampayService.verifyPayment's LATE_RECONCILE_WINDOW_MS for the full
    // gap this closes — a payment that succeeds (e.g. via a gallery-scan
    // retry after an app-side failure) just after this order's checkout
    // timer expired and cancelOrder() had already marked it 'cancelled'/
    // 'timeout'. fampayService.verifyPayment already enforces its own
    // idempotency (status is re-checked against the same window on every
    // call) and the identical "not already claimed" UTR/txn-id dedup
    // used for normal pending orders, so running this is safe even if a
    // customer's own late page-poll or another cron overlap hits the
    // same order at the same time.
    let famVerified = 0, famStillUnmatched = 0, famErrored = 0;
    try {
      const recentlyCancelled = await firebaseService.getRecentlyCancelledFampayOrders();
      logger.info(`[cron] reconcile-fampay-late: checking ${recentlyCancelled.length} recently-cancelled order(s)`);
      for (const order of recentlyCancelled) {
        try {
          const result = await fampayService.verifyPayment(order.orderId);
          if (result) famVerified++;
          else famStillUnmatched++;
        } catch (e) {
          famErrored++;
          logger.warn(`[cron] reconcile-fampay-late: order ${order.orderId} failed: ${e.message}`);
        }
      }
      logger.info(`[cron] reconcile-fampay-late done: ${famVerified} reconciled, ${famStillUnmatched} still unmatched, ${famErrored} errored`);
    } catch (famErr) {
      logger.error('[cron] reconcile-fampay-late fatal error:', famErr.message);
    }

    // ─── Still-pending FamPay orders, same cron run ────────────────────
    // Closes the other half of the gap the late-reconcile sweep above
    // only partially covers: a FamPay order that's still 'pending' (not
    // yet 'cancelled'/'timeout') whose checkout tab stopped polling —
    // most commonly because the customer switched away to their UPI app
    // to actually pay, and the mobile browser throttled/paused that
    // backgrounded tab's JS timers while they were gone. Without this,
    // such an order only ever gets re-checked if/when the customer
    // reopens that same tab, which may never happen even though the
    // payment itself genuinely went through. See
    // firebaseService.getPendingFampayOrders for the exact window.
    // Same idempotency/dedup guarantees as the sweep above — safe to run
    // concurrently with a customer's own live poll.
    let famPendingVerified = 0, famPendingStillUnmatched = 0, famPendingErrored = 0;
    try {
      const stillPending = await firebaseService.getPendingFampayOrders();
      logger.info(`[cron] reconcile-fampay-pending: checking ${stillPending.length} still-pending order(s)`);
      for (const order of stillPending) {
        try {
          const result = await fampayService.verifyPayment(order.orderId);
          if (result) famPendingVerified++;
          else famPendingStillUnmatched++;
        } catch (e) {
          famPendingErrored++;
          logger.warn(`[cron] reconcile-fampay-pending: order ${order.orderId} failed: ${e.message}`);
        }
      }
      logger.info(`[cron] reconcile-fampay-pending done: ${famPendingVerified} verified, ${famPendingStillUnmatched} still unmatched, ${famPendingErrored} errored`);
    } catch (famPendingErr) {
      logger.error('[cron] reconcile-fampay-pending fatal error:', famPendingErr.message);
    }

    return res.json({
      success: true,
      paytm: { checked: pending.length, verified, stillPending, errored },
      fampayLateReconcile: { verified: famVerified, stillUnmatched: famStillUnmatched, errored: famErrored },
      fampayStillPending: { verified: famPendingVerified, stillUnmatched: famPendingStillUnmatched, errored: famPendingErrored },
    });
  } catch (err) {
    logger.error('[cron] verify-paytm-orders fatal error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

},

// ===== routes/upload.js =====
"routes/upload.js": function (module, exports, __r) {
// routes/upload.js
//
// Proxies image uploads to imgbb so the imgbb API key never has to reach
// the client (a client-side fetch straight to imgbb would put the key in
// the browser's JS, visible to anyone via DevTools — this route exists
// purely to keep that key server-side only, same reasoning as the ZapAPI
// key never being logged, or FIREBASE_CLIENT_EMAIL/PRIVATE_KEY never
// shipping to the panel).
//
// Client sends a base64 data URL (from FileReader on their chosen file)
// as plain JSON — not multipart/form-data, since this backend has no
// multipart-parsing middleware (multer etc.) installed, and imgbb's own
// API already accepts a base64 `image` field directly, so no new
// dependency is needed to support this.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authenticate, blockIfBanned, blockIfImpersonating } = __r("middleware/auth.js");
const firebaseService = __r("services/firebaseService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

// This route's body-size limit is set independently of the app-wide 1mb
// JSON limit (server.js) — a base64-encoded image is ~33% larger than
// its original binary size, so a modest logo image can exceed 1mb once
// encoded. Scoped to just this route rather than raising the global
// limit, so the rest of the API surface doesn't gain a larger attack
// surface for oversized request bodies just to support this one feature.
const uploadBodyLimit = express.json({ limit: '8mb' });

/**
 * POST /api/upload/store-logo
 * Body: { imageBase64: "data:image/png;base64,..." }
 * Returns: { url: "https://i.ibb.co/..." }
 */
const handleImageUpload = async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return response.error(res, 'No image provided', 400);
    }

    // Strip the "data:image/png;base64," prefix if present — imgbb's API
    // wants the raw base64 payload only, not the full data URL.
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    // Rough size guard on the decoded payload (base64 length * 0.75 ≈
    // decoded byte size) — rejects an oversized image with a clear
    // message before spending an outbound call to imgbb on it.
    const approxBytes = base64Data.length * 0.75;
    if (approxBytes > 5 * 1024 * 1024) {
      return response.error(res, 'Image must be under 5MB', 400);
    }

    const settings = await firebaseService.getSettings();
    const apiKey = settings.imgbbApiKey;
    if (!apiKey) {
      logger.error('Store logo upload attempted but no imgbbApiKey is configured in settings.');
      return response.error(res, 'Logo upload is not configured. Contact support.', 503);
    }

    const params = new URLSearchParams();
    params.append('key', apiKey);
    params.append('image', base64Data);

    const imgbbRes = await axios.post('https://api.imgbb.com/1/upload', params, {
      timeout: 20000,
    });

    const url = imgbbRes.data?.data?.url;
    if (!url) {
      logger.error('imgbb upload succeeded but returned no URL:', JSON.stringify(imgbbRes.data));
      return response.error(res, 'Upload failed — try again.', 502);
    }

    return response.success(res, 'Image uploaded', { url });
  } catch (err) {
    // imgbb's own error responses (bad key, quota, invalid image) come
    // back as err.response.data — surfaced in the log for diagnosis, but
    // not verbatim to the client, since imgbb's error text may reference
    // internal details (like confirming whether the key itself is valid)
    // that shouldn't leak to a merchant's browser.
    logger.error('Store logo upload error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return response.error(res, 'Upload failed — try again.', 502);
  }
};

router.post('/store-logo', authenticate, blockIfBanned, blockIfImpersonating, uploadBodyLimit, handleImageUpload);

/**
 * POST /api/upload/image
 * Same behaviour as /store-logo (base64 data URL in, hosted URL out) —
 * a neutral path for other features such as Bug Bounty screenshots.
 */
router.post('/image', authenticate, blockIfBanned, blockIfImpersonating, uploadBodyLimit, handleImageUpload);

module.exports = router;

},

// ===== routes/staff.js =====
"routes/staff.js": function (module, exports, __r) {
// routes/staff.js — Management → Staff
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = __r("middleware/auth.js");
const { staffLoginLimiter } = __r("middleware/rateLimiter.js");
const ctrl = __r("controllers/staffController.js");

// Public: staff sign in with the username + password their owner created.
router.post('/login', staffLoginLimiter, ctrl.login);

// Everything below: the account OWNER only.
router.use(authenticate, blockIfBanned, ctrl.ownerOnly);
router.get('/', ctrl.list);
router.post('/', blockIfImpersonating, ctrl.create);
router.put('/:id', blockIfImpersonating, ctrl.update);
router.post('/:id/reset-password', blockIfImpersonating, ctrl.resetPassword);
router.delete('/:id', blockIfImpersonating, ctrl.remove);

module.exports = router;

},

// ===== controllers/staffController.js =====
"controllers/staffController.js": function (module, exports, __r) {
// controllers/staffController.js
const jwt = require('jsonwebtoken');
const staffService = __r("services/staffService.js");
const firebaseService = __r("services/firebaseService.js");
const { PERMISSIONS, ROLE_PRESETS } = __r("config/staffPermissions.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

const STAFF_TOKEN_TTL = '12h';

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof staffService.StaffError) return response.error(res, err.message, err.status, err.extra);
    logger.error(`Staff controller error: ${err.stack || err.message}`);
    return response.serverError(res, 'Something went wrong. Please try again.');
  }
};

/** Staff members can never manage staff — owner only (also enforced by default-deny in auth middleware). */
const ownerOnly = (req, res, next) => {
  if (req.user && req.user.staff) {
    return response.error(res, 'Only the account owner can manage staff.', 403);
  }
  next();
};

// POST /api/staff/login  (public)
const login = wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const { owner, staff } = await staffService.login(username, password);
  const token = jwt.sign(
    { uid: owner.uid, email: owner.email, role: 'user', staffId: staff.id, tokenVersion: staff.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: STAFF_TOKEN_TTL }
  );
  firebaseService.logActivity(owner.uid, 'STAFF_LOGIN', { staffId: staff.id, staffName: staff.name, ip: req.ip }).catch(() => {});
  return response.success(res, 'Signed in', { token, user: staffService.sessionUser(owner, staff) });
});

// GET /api/staff
const list = wrap(async (req, res) => {
  const data = await staffService.listStaff(req.user.uid);
  return response.success(res, 'Staff fetched', {
    ...data,
    permissionsMeta: PERMISSIONS,
    rolePresets: ROLE_PRESETS,
    limitsByPlan: staffService.STAFF_LIMITS_BY_PLAN,
  });
});

// POST /api/staff
const create = wrap(async (req, res) => {
  const staff = await staffService.createStaff(req.user.uid, req.body || {}, 'owner');
  firebaseService.logActivity(req.user.uid, 'STAFF_CREATED', { staffId: staff.id, username: staff.username }).catch(() => {});
  return response.success(res, 'Staff account created', { staff }, 201);
});

// PUT /api/staff/:id
const update = wrap(async (req, res) => {
  const staff = await staffService.updateStaff(req.user.uid, req.params.id, req.body || {});
  return response.success(res, 'Staff account updated', { staff });
});

// POST /api/staff/:id/reset-password
const resetPassword = wrap(async (req, res) => {
  await staffService.resetPassword(req.user.uid, req.params.id, (req.body || {}).password);
  firebaseService.logActivity(req.user.uid, 'STAFF_PASSWORD_RESET', { staffId: req.params.id }).catch(() => {});
  return response.success(res, 'Password updated. The staff member was signed out everywhere.');
});

// DELETE /api/staff/:id
const remove = wrap(async (req, res) => {
  await staffService.removeStaff(req.user.uid, req.params.id);
  firebaseService.logActivity(req.user.uid, 'STAFF_REMOVED', { staffId: req.params.id }).catch(() => {});
  return response.success(res, 'Staff account removed');
});

module.exports = { ownerOnly, login, list, create, update, resetPassword, remove };

},

// ===== routes/merchantPromo.js =====
"routes/merchantPromo.js": function (module, exports, __r) {
// routes/merchantPromo.js — Management → Promo Codes
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = __r("middleware/auth.js");
const { promoLimiter } = __r("middleware/rateLimiter.js");
const ctrl = __r("controllers/merchantPromoController.js");

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

},

// ===== controllers/merchantPromoController.js =====
"controllers/merchantPromoController.js": function (module, exports, __r) {
// controllers/merchantPromoController.js
const promoSvc = __r("services/merchantPromoService.js");
const response = __r("helpers/response.js");
const logger = __r("utils/logger.js");

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

},

// ===== middleware/errorHandler.js =====
"middleware/errorHandler.js": function (module, exports, __r) {
// middleware/errorHandler.js - Global Error Handler
const logger = __r("utils/logger.js");

/**
 * Global error handling middleware
 * Must be registered last in Express app
 */
const errorHandler = (err, req, res, next) => {
  logger.error(`${req.method} ${req.path} - ${err.message}`, {
    stack: err.stack,
    body: req.body,
    user: req.user?.uid,
  });

  // Mongoose/Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: Object.values(err.errors).map((e) => e.message),
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired' });
  }

  // Firebase errors
  if (err.code && err.code.startsWith('auth/')) {
    return res.status(401).json({ success: false, message: err.message });
  }

  // Default
  const statusCode = err.statusCode || err.status || 500;
  const message =
    process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : err.message || 'Something went wrong';

  return res.status(statusCode).json({ success: false, message });
};

/**
 * 404 handler for unmatched routes
 */
const notFoundHandler = (req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
};

module.exports = errorHandler;
module.exports.notFoundHandler = notFoundHandler;

},
};

const __cache = {};
function __r(id) {
  if (__cache[id]) return __cache[id].exports;
  const module = (__cache[id] = { exports: {} });
  __defs[id].call(module.exports, module, module.exports, __r);
  return module.exports;
}

module.exports = __r("server.js");
