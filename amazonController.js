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
const encryption = require('../utils/encryption');
const response = require('../helpers/response');
const firebaseService = require('../services/firebaseService');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');
const { fetchAmazonHistory } = require('./historyController');

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
