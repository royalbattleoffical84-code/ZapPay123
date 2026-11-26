// routes/amazon.js
const express = require('express');
const router = express.Router();
const amazonController = require('../controllers/amazonController');
const { authenticate, blockIfBanned } = require('../middleware/auth');

// Multi-account endpoints (same shape as /api/fampay and /api/paytm)
router.get('/accounts', authenticate, blockIfBanned, amazonController.getAmazonAccounts);
router.post('/accounts/add', authenticate, blockIfBanned, amazonController.addAmazonAccountBasic);
router.post('/accounts/verify', authenticate, blockIfBanned, amazonController.verifyAmazonAccount);
router.post('/accounts/activate', authenticate, blockIfBanned, amazonController.setActiveAmazonAccount);
router.post('/accounts/remove', authenticate, blockIfBanned, amazonController.removeAmazonAccount);

router.get('/status', authenticate, blockIfBanned, amazonController.getAmazonStatus);
router.post('/disconnect', authenticate, blockIfBanned, amazonController.disconnectAmazon);

// Live email history
router.get('/history', authenticate, blockIfBanned, amazonController.getHistory);

module.exports = router;
