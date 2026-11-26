// controllers/npciUpiController.js
// All UPI - NPCI UPI Controller
const { body, validationResult } = require('express-validator');
const npciUpiService = require('../services/npciUpiService');

// Validation rules
const sendOtpValidation = [
  body('phone').isMobilePhone('en-IN').withMessage('Invalid Indian mobile number'),
  body('upiId').matches(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/).withMessage('Invalid UPI ID format'),
  body('captcha').notEmpty().withMessage('Captcha is required'),
  body('cookies').notEmpty().withMessage('Session cookies required'),
];

const validateOtpValidation = [
  body('phone').notEmpty().withMessage('Phone is required'),
  body('upiId').notEmpty().withMessage('UPI ID is required'),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('OTP must be 6 digits'),
  body('bankLast4').isLength({ min: 4, max: 4 }).isNumeric().withMessage('Bank last 4 must be 4 digits'),
  body('csrfToken').notEmpty().withMessage('CSRF token required'),
  body('cookies').notEmpty().withMessage('Session cookies required'),
];

// Get Captcha
// Get Captcha — with HTML debug
const getCaptcha = async () => {
  try {
    console.log('Fetching NPCI homepage...');
    
    const homeRes = await axios.get(NPCI_BASE_URL + '/', {
      headers: getHeaders(),
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    
    console.log('Homepage status:', homeRes.status);
    console.log('Homepage headers:', JSON.stringify(homeRes.headers).substring(0, 500));
    
    const html = homeRes.data;
    console.log('HTML length:', html.length);
    console.log('HTML first 500 chars:', html.substring(0, 500));
    
    // Save full HTML to log
    console.log('Full HTML:', html.substring(0, 2000));
    
    // ... rest of code
  } catch (error) {
    console.error('NPCI getCaptcha FULL ERROR:', error);
    console.error('Error response:', error.response?.data);
    console.error('Error status:', error.response?.status);
    return { 
      success: false, 
      message: error.message,
      errorDetails: {
        status: error.response?.status,
        data: error.response?.data?.substring?.(0, 500),
      }
    };
  }
};



// Send OTP
const sendOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
    }

    const { phone, upiId, captcha, cookies } = req.body;
    const result = await npciUpiService.sendOtp(phone, upiId, captcha, cookies);

    if (result.success) {
      return res.json({
        success: true,
        data: {
          csrfToken: result.csrfToken,
          cookies: result.cookies,
        },
        message: result.message,
      });
    }

    return res.status(400).json({
      success: false,
      message: result.message,
    });
  } catch (error) {
    console.error('sendOtp error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

// Validate OTP
const validateOtp = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
    }

    const { phone, upiId, otp, bankLast4, csrfToken, cookies } = req.body;
    const result = await npciUpiService.validateOtp(phone, upiId, otp, bankLast4, csrfToken, cookies);

    if (result.success) {
      return res.json({
        success: true,
        data: {
          upiId: upiId,
          phone: phone,
          session: result.session,
        },
        message: result.message,
      });
    }

    return res.status(400).json({
      success: false,
      message: result.message,
    });
  } catch (error) {
    console.error('validateOtp error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

module.exports = {
  getCaptcha,
  sendOtp,
  validateOtp,
  sendOtpValidation,
  validateOtpValidation,
};
