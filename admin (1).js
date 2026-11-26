// routes/admin.js
const express = require('express');
const router = express.Router();
const admin = require('../controllers/adminController');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');

// Apply auth + admin check to ALL admin routes
router.use(authenticate, requireAdmin);

router.get('/dashboard', admin.getDashboard);
router.get('/users', admin.getUsers);
router.post('/users/delete-unverified', admin.deleteUnverifiedUsers);
// Alias: some deployed frontend builds call this as DELETE /users-unverified
// (no slash, DELETE method) instead of the original POST /users/delete-unverified.
// Both point to the same handler so whichever shape the live frontend uses works.
router.delete('/users-unverified', admin.deleteUnverifiedUsers);
router.get('/users/:uid', admin.getUserDetail);
router.post('/users/:uid/ban', admin.toggleBan);
router.post('/users/:uid/clear-device', admin.clearUserDevice);
router.post('/users/:uid/reset-login-activity', admin.adminResetLoginActivity);
router.delete('/users/:uid', admin.deleteUser);
router.post('/wallet/adjust', admin.adjustWalletValidation, admin.adjustWallet);
router.get('/payments', admin.getAllPayments);
router.get('/withdrawals', admin.getAllWithdrawals);
router.put('/withdrawals/:id/approve', admin.approveWithdrawal);
router.put('/withdrawals/:id/reject', admin.rejectWithdrawal);
router.get('/settings', admin.getSettings);
router.put('/settings', admin.updateSettings);
router.get('/verification-logs', admin.getVerificationLogs);
router.post('/notifications/send', admin.sendBroadcast);
router.get('/referrals', admin.getAllReferrals);

// ── Management oversight: staff accounts, merchant promo codes, Weekly Airdrop ──
const mgmt = require('../controllers/adminMgmtController');
router.get('/staff',                                   mgmt.listStaff);
router.post('/staff/:ownerUid/:staffId/status',        mgmt.setStaffStatus);
router.post('/staff/:ownerUid/:staffId/logout',        mgmt.forceStaffLogout);
router.delete('/staff/:ownerUid/:staffId',             mgmt.removeStaff);
router.get('/merchant-promos',                         mgmt.listMerchantPromos);
router.put('/merchant-promos/:ownerUid/:code/toggle',  mgmt.toggleMerchantPromo);
router.delete('/merchant-promos/:ownerUid/:code',      mgmt.deleteMerchantPromo);
router.get('/airdrop',                                 mgmt.airdropOverview);
router.post('/airdrop/grant',                          mgmt.airdropGrant);
router.post('/airdrop/revoke',                         mgmt.airdropRevoke);

module.exports = router;

// ── Subscription + Plan routes (admin only, already uses authenticate+requireAdmin) ──
const subCtrl = require('../controllers/subscriptionController');
const plCtrl  = require('../controllers/paymentLinkController');
const promoCtrl = require('../controllers/promoController');

router.get('/plans',                    subCtrl.adminGetPlans);
router.post('/plans',                   subCtrl.planValidation, subCtrl.adminCreatePlan);
router.put('/plans/:id',                subCtrl.adminUpdatePlan);
router.delete('/plans/:id',             subCtrl.adminDeletePlan);
router.post('/users/:uid/subscription', subCtrl.adminAssignPlan);
router.get('/payment-links',            subCtrl.adminGetPaymentLinks);
router.get('/commission-logs',          subCtrl.adminGetCommissionLogs);
router.get('/promo-codes',              promoCtrl.adminGetPromoCodes);
router.post('/promo-codes',             promoCtrl.adminCreatePromoCode);
router.put('/promo-codes/:code/toggle', promoCtrl.adminTogglePromoCode);
router.put('/promo-codes/:code',        promoCtrl.adminUpdatePromoCode);
router.delete('/promo-codes/:code',     promoCtrl.adminDeletePromoCode);

// Earn & Rewards — video + bug bounty submission review
router.get('/reward-submissions',          admin.getRewardSubmissions);
router.post('/reward-submissions/:id/resolve', admin.resolveRewardSubmission);

// ── Support chat inbox (admin side) ──
router.get('/support',                  admin.getSupportThreads);
router.get('/support/:uid',             admin.getSupportThreadMessages);
router.post('/support/:uid/reply',      admin.replySupportValidation, admin.replySupportThread);
router.put('/support/:uid/message/:messageId',    admin.editSupportMessageValidation, admin.editSupportMessage);
router.delete('/support/:uid/message/:messageId', admin.deleteSupportMessage);

// ── Controller: per-user activity log + personal notification sender ──
router.get('/users/:uid/activity',      admin.getUserActivity);
router.post('/users/:uid/notify',       admin.sendUserNotificationValidation, admin.sendUserNotification);
router.post('/users/:uid/impersonate',  admin.impersonateUser);
