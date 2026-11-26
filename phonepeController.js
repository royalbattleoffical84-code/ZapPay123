// controllers/phonepeController.js
// PhonePe Controller — Gateway Pattern

const phonepeService = require('../services/phonepeService');
const { body, validationResult } = require('express-validator');
const response = require('../helpers/response');
const logger = require('../utils/logger');

// Validation rules
const sendOtpValidation = [
  body('phone').isMobilePhone('en-IN').withMessage('Valid 10-digit Indian phone required')
];

const verifyOtpValidation = [
  body('sessionId').notEmpty().withMessage('Session ID required'),
  body('otp').isLength({ min: 4, max: 6 }).isNumeric().withMessage('Valid OTP required')
];

// Send OTP
const sendOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return response.error(res, 'Validation failed', 400, errors.array());
    }

    const { phone } = req.body;
    const result = await phonepeService.sendOtp(phone);

    if (result.success) {
      return response.success(res, { sessionId: result.sessionId }, 'OTP sent successfully');
    }

    return response.error(res, result.message, 400);
  } catch (error) {
    logger.error('phonepeController.sendOtp error: ' + error.message);
    return response.error(res, 'Server error', 500);
  }
};

// Verify OTP
const verifyOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return response.error(res, 'Validation failed', 400, errors.array());
    }

    const { sessionId, otp } = req.body;
    const result = await phonepeService.verifyOtp(sessionId, otp);

    if (result.success) {
      return response.success(res, {
        phone: result.phone,
        merchantId: result.merchantId
      }, 'PhonePe connected successfully');
    }

    return response.error(res, result.message, 400);
  } catch (error) {
    logger.error('phonepeController.verifyOtp error: ' + error.message);
    return response.error(res, 'Server error', 500);
  }
};

// Get History
const getHistory = async (req, res) => {
  try {
    const { phone } = req.query;
    const { from } = req.query;

    if (!phone) {
      return response.error(res, 'Phone number required', 400);
    }

    const result = await phonepeService.getHistory(phone, from ? parseInt(from) : null);

    if (result.success) {
      return response.success(res, { transactions: result.transactions }, 'History fetched');
    }

    return response.error(res, result.message, 400);
  } catch (error) {
    logger.error('phonepeController.getHistory error: ' + error.message);
    return response.error(res, 'Server error', 500);
  }
};

// Verify Payment
const verifyPayment = async (req, res) => {
  try {
    const { phone, utr, amount } = req.body;

    if (!phone || !utr || !amount) {
      return response.error(res, 'Phone, UTR, and amount required', 400);
    }

    const result = await phonepeService.verifyPayment(phone, utr, parseFloat(amount));

    if (result.success && result.verified) {
      return response.success(res, {
        verified: true,
        transaction: result.transaction
      }, 'Payment verified');
    }

    return response.success(res, { verified: false }, result.message || 'Not found');
  } catch (error) {
    logger.error('phonepeController.verifyPayment error: ' + error.message);
    return response.error(res, 'Server error', 500);
  }
};

// Get Status
const getStatus = async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return response.error(res, 'Phone number required', 400);
    }

    const result = await phonepeService.getStatus(phone);
    return response.success(res, result, 'Status fetched');
  } catch (error) {
    logger.error('phonepeController.getStatus error: ' + error.message);
    return response.error(res, 'Server error', 500);
  }
};

// Disconnect
const disconnect = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return response.error(res, 'Phone number required', 400);
    }

    const result = await phonepeService.disconnect(phone);

    if (result.success) {
      return response.success(res, null, 'PhonePe disconnected');
    }

    return response.error(res, result.message, 400);
  } catch (error) {
    logger.error('phonepeController.disconnect error: ' + error.message);
    return response.error(res, 'Server error', 500);
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
  getHistory,
  verifyPayment,
  getStatus,
  disconnect,
  sendOtpValidation,
  verifyOtpValidation
};
