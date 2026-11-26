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
const { ref } = require('../firebase/admin');
const { DB_PATHS, STAFF_LIMITS_BY_PLAN } = require('../config/constants');
const { PERMISSION_KEYS } = require('../config/staffPermissions');
const subscriptionService = require('./subscriptionService');
const logger = require('../utils/logger');

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
