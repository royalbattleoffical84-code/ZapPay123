// routes/reward.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rewardController');
const { authenticate, blockIfBanned } = require('../middleware/auth');

router.use(authenticate, blockIfBanned);

router.post('/video', ctrl.submitVideo);
router.post('/bug', ctrl.submitBug);
router.get('/mine', ctrl.getMySubmissions);

module.exports = router;
