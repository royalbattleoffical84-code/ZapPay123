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
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');

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
