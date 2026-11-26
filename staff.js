// routes/staff.js — Management → Staff
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const { staffLoginLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/staffController');

// Public: staff sign in with the username + password their owner created.
router.post('/login', staffLoginLimiter, ctrl.login);

// Everything below: the account OWNER only.
router.use(authenticate, blockIfBanned, ctrl.ownerOnly);
router.get('/', ctrl.list);
router.post('/', blockIfImpersonating, ctrl.create);
router.put('/:id', blockIfImpersonating, ctrl.update);
router.post('/:id/reset-password', blockIfImpersonating, ctrl.resetPassword);
router.delete('/:id', blockIfImpersonating, ctrl.remove);

module.exports = router;
