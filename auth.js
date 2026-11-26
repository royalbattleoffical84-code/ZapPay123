// middleware/auth.js - JWT Authentication Middleware
const jwt = require('jsonwebtoken');
const { ref } = require('../firebase/admin');
const response = require('../helpers/response');
const logger = require('../utils/logger');
const { checkStaffAccess } = require('../config/staffPermissions');

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
