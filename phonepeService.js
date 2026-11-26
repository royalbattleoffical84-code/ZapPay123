// services/phonepeService.js
// PhonePe Business API Service
// Pattern: firebaseService + walletService + webhookService + notificationService

const axios = require('axios');
const crypto = require('crypto');
const firebaseService = require('./firebaseService');
const walletService = require('./walletService');
const webhookService = require('./webhookService');
const notificationService = require('./notificationService');
const encryption = require('../utils/encryption');
const logger = require('../utils/logger');
const { ref } = require('../firebase/admin');
const { DB_PATHS, VERIFICATION_METHOD } = require('../config/constants');

const PHONEPE_API = 'https://business-api.phonepe.com';
const APP_ID = 'bd309814ea4c45078b9b25bd52a576de';
const MERCHANT_ID = 'PHONEPEBUSINESS';
const APP_VERSION = '0.4.52';
const SOURCE_VERSION = '1290004052';

// ── Device Fingerprint Generation ──
function randomString(length, chars = '0123456789abcdef') {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[crypto.randomInt(0, chars.length)];
  }
  return result;
}

function randomNumber(length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += crypto.randomInt(0, 10);
  }
  return result;
}

function generateDeviceFingerprint() {
  const mom = randomString(16);
  const mon = randomString(64);
  const aa = crypto.createHash('sha256').update(randomNumber(19)).digest('hex').substring(0, 32);
  const aa2 = crypto.createHash('sha256').update(randomNumber(13)).digest('hex').substring(0, 32);

  return {
    deviceFingerprint: mom + 'c2RtNjM2-cWNvbQ-',
    fingerprint: aa2 + '.' + aa + '.Xiaomi.' + mon,
    raw: { mom, mon, aa, aa2 }
  };
}

function generateChecksum(payload, endpoint) {
  const timestamp = Date.now();
  const nonce = randomString(16);
  const dataToHash = endpoint + payload + timestamp + nonce;
  const checksum = crypto.createHash('sha256').update(dataToHash).digest('base64');
  return { checksum, timestamp, nonce };
}

function getRandomIP() {
  return `${crypto.randomInt(1, 240)}.${crypto.randomInt(1, 240)}.${crypto.randomInt(1, 240)}.${crypto.randomInt(1, 240)}`;
}

// ── Send OTP ──
const sendOtp = async (phone) => {
  try {
    logger.info(`PhonePe: Sending OTP to ${phone}`);

    const device = generateDeviceFingerprint();
    const ip = getRandomIP();

    const endpoint = '/apis/merchant-insights/v3/auth/sendOtp';
    const url = PHONEPE_API + endpoint;

    const payload = {
      type: 'OTP',
      phoneNumber: phone,
      deviceFingerprint: device.deviceFingerprint
    };

    const payloadStr = JSON.stringify(payload);
    const { checksum } = generateChecksum(payloadStr, endpoint);

    const headers = {
      'Host': 'business-api.phonepe.com',
      'x-app-id': APP_ID,
      'x-merchant-id': MERCHANT_ID,
      'x-source-type': 'PB_APP',
      'x-source-platform': 'ANDROID',
      'x-source-locale': 'en',
      'x-source-version': SOURCE_VERSION,
      'fingerprint': device.fingerprint,
      'x-device-fingerprint': device.deviceFingerprint,
      'x-app-version': APP_VERSION,
      'x-request-sdk-checksum': checksum,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/3.12.13',
      'X-Forwarded-For': ip
    };

    const response = await axios.post(url, payload, { 
      headers,
      timeout: 15000,
      validateStatus: () => true
    });

    if (response.status === 200 && response.data?.token) {
      // Store pending session in Firebase
      const sessionId = randomString(32);
      await firebaseService.setData(`phonepe_pending/${sessionId}`, {
        phone,
        token: response.data.token,
        device: encryption.encrypt(JSON.stringify(device)),
        ip,
        createdAt: Date.now()
      });

      logger.info(`PhonePe: OTP sent, session ${sessionId}`);
      return { success: true, sessionId };
    }

    logger.error(`PhonePe OTP failed: ${response.status} ${JSON.stringify(response.data)}`);
    return { 
      success: false, 
      message: response.data?.message || `PhonePe API error: ${response.status}` 
    };
  } catch (error) {
    logger.error('PhonePe sendOtp error: ' + error.message);
    return { success: false, message: error.message };
  }
};

// ── Verify OTP ──
const verifyOtp = async (sessionId, otp) => {
  try {
    logger.info(`PhonePe: Verifying OTP for session ${sessionId}`);

    // Get pending session from Firebase
    const pending = await firebaseService.getData(`phonepe_pending/${sessionId}`);
    if (!pending) {
      return { success: false, message: 'Session expired. Send OTP again.' };
    }

    const device = JSON.parse(encryption.decrypt(pending.device));
    const { token } = pending;

    const endpoint = '/apis/merchant-insights/v3/auth/login';
    const url = PHONEPE_API + endpoint;

    const fact2 = device.deviceFingerprint.substring(0, 16);
    const fpParts = device.fingerprint.split('.');
    const g1 = fpParts[3] || '';
    const osid = fpParts[0] || '';
    const xdhp = fpParts[1] || '';

    const clientContext = JSON.stringify({
      device: {
        identifier: {
          macAddress: '00:00:00:00:00:00',
          fact1: '',
          fact2: fact2,
          fact3: 'NA',
          gd: { g1: g1 },
          omid: 'Xiaomi',
          osid: osid,
          pid: 'NA',
          xdhp: xdhp
        },
        location: { latitude: 0, longitude: 0, confidence: 0, locs: -1 },
        network: { ipv4: pending.ip, ipv6: 'NA' }
      }
    });

    const payload = {
      type: 'OTP',
      clientContext: clientContext,
      otp: otp,
      token: token
    };

    const payloadStr = JSON.stringify(payload);
    const { checksum } = generateChecksum(payloadStr, endpoint);

    const headers = {
      'Host': 'business-api.phonepe.com',
      'x-app-id': APP_ID,
      'x-merchant-id': MERCHANT_ID,
      'x-source-type': 'PB_APP',
      'x-source-platform': 'ANDROID',
      'x-source-locale': 'en',
      'x-source-version': SOURCE_VERSION,
      'fingerprint': device.fingerprint,
      'x-device-fingerprint': device.deviceFingerprint,
      'x-app-version': APP_VERSION,
      'x-request-sdk-checksum': checksum,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/3.12.13'
    };

    const response = await axios.post(url, payload, { 
      headers,
      timeout: 15000,
      validateStatus: () => true
    });

    if (response.status === 200 && response.data?.token) {
      const { token: authToken, refreshToken, merchantId, userId } = response.data;

      // Save connection to Firebase
      await firebaseService.setData(`phonepe_connections/${pending.phone}`, {
        phone: pending.phone,
        authToken: encryption.encrypt(authToken),
        refreshToken: encryption.encrypt(refreshToken),
        merchantId,
        userId,
        device: pending.device,
        ip: pending.ip,
        isActive: true,
        connectedAt: Date.now()
      });

      // Clear pending
      await firebaseService.removeData(`phonepe_pending/${sessionId}`);

      logger.info(`PhonePe: Connected ${pending.phone}, merchant ${merchantId}`);
      return { success: true, phone: pending.phone, merchantId };
    }

    logger.error(`PhonePe verify failed: ${response.status}`);
    return { success: false, message: 'OTP verification failed' };
  } catch (error) {
    logger.error('PhonePe verifyOtp error: ' + error.message);
    return { success: false, message: error.message };
  }
};

// ── Refresh Token ──
const refreshToken = async (phone) => {
  try {
    const conn = await firebaseService.getData(`phonepe_connections/${phone}`);
    if (!conn || !conn.isActive) {
      return { success: false, message: 'Not connected' };
    }

    const authToken = encryption.decrypt(conn.authToken);
    const refreshToken = encryption.decrypt(conn.refreshToken);
    const device = JSON.parse(encryption.decrypt(conn.device));

    const endpoint = '/apis/merchant-insights/v1/auth/refresh';
    const url = PHONEPE_API + endpoint;

    const payload = {};
    const payloadStr = JSON.stringify(payload);
    const { checksum } = generateChecksum(payloadStr, endpoint);

    const headers = {
      'Host': 'business-api.phonepe.com',
      'x-refresh-token': refreshToken,
      'x-auth-token': authToken,
      'x-farm-request-id': randomString(32),
      'x-app-id': APP_ID,
      'x-merchant-id': MERCHANT_ID,
      'x-source-type': 'PB_APP',
      'x-source-platform': 'ANDROID',
      'x-source-locale': 'en',
      'x-source-version': '1290004039',
      'fingerprint': device.fingerprint,
      'x-device-fingerprint': device.deviceFingerprint,
      'x-app-version': '0.4.39',
      'x-request-sdk-checksum': checksum,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/3.12.13',
      'X-Forwarded-For': conn.ip
    };

    const response = await axios.post(url, payload, { 
      headers,
      timeout: 15000,
      validateStatus: () => true
    });

    if (response.status === 200 && response.data?.token) {
      // Update tokens
      await firebaseService.updateData(`phonepe_connections/${phone}`, {
        authToken: encryption.encrypt(response.data.token),
        refreshToken: encryption.encrypt(response.data.refreshToken),
        lastRefresh: Date.now()
      });

      return { success: true };
    }

    return { success: false, message: 'Token refresh failed' };
  } catch (error) {
    logger.error('PhonePe refreshToken error: ' + error.message);
    return { success: false, message: error.message };
  }
};

// ── Get Transaction History ──
const getHistory = async (phone, fromTimestamp = null) => {
  try {
    // Refresh token first
    await refreshToken(phone);

    const conn = await firebaseService.getData(`phonepe_connections/${phone}`);
    if (!conn || !conn.isActive) {
      return { success: false, message: 'Not connected' };
    }

    const authToken = encryption.decrypt(conn.authToken);
    const device = JSON.parse(encryption.decrypt(conn.device));

    const endpoint = '/apis/merchant-insights/v3/transactions/changes';
    const url = PHONEPE_API + endpoint;

    const to = Date.now();
    const from = fromTimestamp || (to - 7 * 24 * 60 * 60 * 1000);

    const payload = { from, merchantId: conn.merchantId, to };
    const payloadStr = JSON.stringify(payload);
    const { checksum } = generateChecksum(payloadStr, endpoint);

    const headers = {
      'Host': 'business-api.phonepe.com',
      'x-auth-token': authToken,
      'x-app-id': APP_ID,
      'x-merchant-id': MERCHANT_ID,
      'x-source-type': 'PB_APP',
      'x-source-platform': 'ANDROID',
      'x-source-locale': 'en',
      'x-source-version': SOURCE_VERSION,
      'fingerprint': device.fingerprint,
      'x-device-fingerprint': device.deviceFingerprint,
      'x-app-version': APP_VERSION,
      'x-request-sdk-checksum': checksum,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'okhttp/3.12.13',
      'X-Forwarded-For': conn.ip
    };

    const response = await axios.post(url, payload, { 
      headers,
      timeout: 15000,
      validateStatus: () => true
    });

    if (response.status === 200) {
      return { 
        success: true, 
        transactions: response.data?.transactions || [],
        raw: response.data 
      };
    }

    return { success: false, message: `History fetch failed: ${response.status}` };
  } catch (error) {
    logger.error('PhonePe getHistory error: ' + error.message);
    return { success: false, message: error.message };
  }
};

// ── Verify Payment by UTR ──
const verifyPayment = async (phone, utr, amount) => {
  try {
    const history = await getHistory(phone);

    if (!history.success) {
      return history;
    }

    const match = history.transactions.find(txn => {
      const txnUtr = txn.utr || txn.referenceId || '';
      const txnAmount = parseFloat(txn.amount || 0);
      return txnUtr === utr && Math.abs(txnAmount - amount) < 0.01;
    });

    if (match) {
      logger.info(`PhonePe: Verified payment ${utr} ₹${amount}`);
      return { success: true, verified: true, transaction: match };
    }

    return { success: false, verified: false, message: 'Transaction not found' };
  } catch (error) {
    logger.error('PhonePe verifyPayment error: ' + error.message);
    return { success: false, message: error.message };
  }
};

// ── Disconnect ──
const disconnect = async (phone) => {
  try {
    await firebaseService.updateData(`phonepe_connections/${phone}`, {
      isActive: false,
      disconnectedAt: Date.now()
    });
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
};

// ── Get Status ──
const getStatus = async (phone) => {
  try {
    const conn = await firebaseService.getData(`phonepe_connections/${phone}`);
    if (conn && conn.isActive) {
      return {
        success: true,
        connected: true,
        phone: conn.phone,
        merchantId: conn.merchantId,
        connectedAt: conn.connectedAt
      };
    }
    return { success: true, connected: false };
  } catch (error) {
    return { success: false, message: error.message };
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
  refreshToken,
  getHistory,
  verifyPayment,
  disconnect,
  getStatus
};
