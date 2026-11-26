// controllers/staffController.js
const jwt = require('jsonwebtoken');
const staffService = require('../services/staffService');
const firebaseService = require('../services/firebaseService');
const { PERMISSIONS, ROLE_PRESETS } = require('../config/staffPermissions');
const response = require('../helpers/response');
const logger = require('../utils/logger');

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
