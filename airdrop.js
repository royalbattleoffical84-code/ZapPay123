const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/airdropController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
router.use(authenticate, blockIfBanned);
router.get('/status', ctrl.getStatus);
router.post('/claim', ctrl.claim);
router.get('/coupons', ctrl.listCoupons);
module.exports = router;
