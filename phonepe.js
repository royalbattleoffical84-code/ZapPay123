// routes/phonepe.js
// PhonePe Business Routes

const express = require('express');
const router = express.Router();
const phonepeController = require('../controllers/phonepeController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

// All routes require authentication
router.use(authenticate, blockIfBanned);

router.post('/send-otp', paymentLimiter, phonepeController.sendOtpValidation, phonepeController.sendOtp);
router.post('/verify-otp', paymentLimiter, phonepeController.verifyOtpValidation, phonepeController.verifyOtp);
router.get('/history', phonepeController.getHistory);
router.post('/verify-payment', phonepeController.verifyPayment);
router.get('/status', phonepeController.getStatus);
router.post('/disconnect', phonepeController.disconnect);

module.exports = router;
