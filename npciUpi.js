// routes/npciUpi.js
// All UPI - NPCI UPI Routes
const express = require('express');
const router = express.Router();
const npciUpiController = require('../controllers/npciUpiController');

// Public routes (no auth needed for NPCI flow)
router.get('/captcha', npciUpiController.getCaptcha);
router.post('/send-otp', npciUpiController.sendOtpValidation, npciUpiController.sendOtp);
router.post('/validate-otp', npciUpiController.validateOtpValidation, npciUpiController.validateOtp);

module.exports = router;
