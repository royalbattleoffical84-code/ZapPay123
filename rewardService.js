// services/rewardService.js
//
// Backs the "Earn & Rewards" feature's two submission types:
//   - 'video' : a promotional video a merchant made (title + link)
//   - 'bug'   : a bug report (title + description + optional image URLs)
//
// Both share one storage shape and one admin review flow (approve/reject
// with a required comment, plus an optional reward grant on approval).
// This mirrors how withdrawals and KYC-style admin review flows elsewhere
// in this codebase work: a flat collection of submissions, keyed by
// push-id, each carrying its own status and resolution.
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const walletService = require('./walletService');
const subscriptionService = require('./subscriptionService');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

const MAX_BUG_IMAGES = 10;
const MAX_TITLE_LEN = 120;
const MAX_DESCRIPTION_LEN = 3000;
const MAX_LINK_LEN = 500;

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

async function submitVideo(userId, { title, link }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  const cleanLink = String(link || '').trim().slice(0, MAX_LINK_LEN);
  if (!cleanTitle) throw new Error('Video title is required.');
  if (!cleanLink) throw new Error('Video link is required.');
  if (!/^https?:\/\//i.test(cleanLink)) throw new Error('Video link must be a valid URL starting with http(s)://');

  const id = newId('VID');
  const record = {
    id,
    userId,
    type: 'video',
    title: cleanTitle,
    videoLink: cleanLink,
    status: 'pending',
    adminComment: null,
    reward: null,
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedByUid: null,
  };
  await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${id}`).set(record);
  return record;
}

async function submitBug(userId, { title, description, images }) {
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  const cleanDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION_LEN);
  if (!cleanTitle) throw new Error('Bug title is required.');
  if (!cleanDescription) throw new Error('A description of the bug is required.');

  const cleanImages = Array.isArray(images)
    ? images.map((u) => String(u || '').trim()).filter((u) => u && /^https?:\/\//i.test(u)).slice(0, MAX_BUG_IMAGES)
    : [];

  const id = newId('BUG');
  const record = {
    id,
    userId,
    type: 'bug',
    title: cleanTitle,
    description: cleanDescription,
    images: cleanImages,
    status: 'pending',
    adminComment: null,
    reward: null,
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedByUid: null,
  };
  await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${id}`).set(record);
  return record;
}

async function getUserSubmissions(userId) {
  const snap = await ref(DB_PATHS.REWARD_SUBMISSIONS).orderByChild('userId').equalTo(userId).once('value');
  const list = [];
  if (snap.exists()) snap.forEach((c) => list.push(c.val()));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

async function adminListSubmissions({ type, status } = {}) {
  const snap = await ref(DB_PATHS.REWARD_SUBMISSIONS).once('value');
  let list = [];
  if (snap.exists()) snap.forEach((c) => list.push(c.val()));
  if (type) list = list.filter((s) => s.type === type);
  if (status) list = list.filter((s) => s.status === status);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

/**
 * Applies the reward an admin chose when approving a submission. Each
 * reward type reuses an EXISTING mechanism elsewhere in the codebase
 * (wallet credit, plan activation, promo code) rather than inventing a
 * new one, so behavior (notifications, expiry, etc.) stays consistent
 * with how a user would get the same thing any other way.
 */
async function applyReward(userId, reward) {
  if (!reward || !reward.type || reward.type === 'none') return null;

  if (reward.type === 'zap_cash') {
    const amount = parseFloat(reward.amount);
    if (!(amount > 0)) throw new Error('Zap Cash reward amount must be greater than 0.');
    await walletService.creditWallet(userId, amount, 'Earn & Rewards payout');
    return { type: 'zap_cash', amount };
  }

  if (reward.type === 'zap_credit') {
    const amount = parseFloat(reward.amount);
    if (!(amount > 0)) throw new Error('Zap Credit reward amount must be greater than 0.');
    await walletService.creditZapCredit(userId, amount, 'Earn & Rewards payout');
    return { type: 'zap_credit', amount };
  }

  if (reward.type === 'premium_membership') {
    const months = parseInt(reward.months, 10);
    if (!(months >= 1 && months <= 6)) throw new Error('Premium membership reward must be 1–6 months.');
    const planId = reward.planId || 'pro'; // caller should pass a real plan id; 'pro' is a reasonable default if omitted
    const sub = await subscriptionService.activateSubscription(userId, planId, months * 30);
    return { type: 'premium_membership', months, planId, subscription: sub };
  }

  if (reward.type === 'promo_code') {
    const value = parseFloat(reward.amount);
    if (!(value > 0)) throw new Error('Promo code reward value must be greater than 0.');
    const code = `GIFT${newId('')}`.slice(0, 16);
    const balanceType = ['cash', 'credit', 'bonus'].includes(reward.balanceType) ? reward.balanceType : 'bonus';
    await ref(`${DB_PATHS.PROMO_CODES}/${code}`).set({
      code,
      type: 'fixed',
      balanceType,
      value,
      maxUses: 1,
      usedCount: 0,
      perUserLimit: 1,
      isActive: true,
      description: 'Earn & Rewards payout',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days to redeem
      createdAt: Date.now(),
    });
    return { type: 'promo_code', code, value, balanceType };
  }

  throw new Error(`Unknown reward type: ${reward.type}`);
}

/**
 * Approves or rejects a submission. A comment is ALWAYS required (the
 * user explicitly asked for this) — it's the only way the submitter
 * learns why, especially on rejection. Reward is only ever applied on
 * approval, and only once (resolving an already-resolved submission is
 * rejected outright, so a double-click can't double-pay someone).
 */
async function resolveSubmission(submissionId, { status, comment, reward }, adminUid) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('status must be approved or rejected.');
  const cleanComment = String(comment || '').trim();
  if (!cleanComment) throw new Error('A comment is required when approving or rejecting a submission.');

  const snap = await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${submissionId}`).once('value');
  if (!snap.exists()) throw new Error('Submission not found.');
  const submission = snap.val();
  if (submission.status !== 'pending') throw new Error(`This submission was already ${submission.status}.`);

  let appliedReward = null;
  if (status === 'approved' && reward && reward.type && reward.type !== 'none') {
    appliedReward = await applyReward(submission.userId, reward);
  }

  await ref(`${DB_PATHS.REWARD_SUBMISSIONS}/${submissionId}`).update({
    status,
    adminComment: cleanComment,
    reward: appliedReward,
    resolvedAt: Date.now(),
    resolvedByUid: adminUid,
  });

  const kindLabel = submission.type === 'video' ? 'promo video' : 'bug report';
  if (status === 'approved') {
    let rewardLine = '';
    if (appliedReward?.type === 'zap_cash') rewardLine = ` You've been credited ₹${appliedReward.amount} Zap Cash.`;
    else if (appliedReward?.type === 'zap_credit') rewardLine = ` You've been credited ₹${appliedReward.amount} Zap Credit.`;
    else if (appliedReward?.type === 'premium_membership') rewardLine = ` You've been granted ${appliedReward.months} month(s) of premium membership.`;
    else if (appliedReward?.type === 'promo_code') rewardLine = ` Here's your reward code: ${appliedReward.code} (worth ₹${appliedReward.value}).`;
    await notificationService.createNotification(submission.userId, {
      title: `🎉 Your ${kindLabel} was approved!`,
      message: `"${submission.title}" has been approved.${rewardLine} Admin note: ${cleanComment}`,
      type: 'general',
    });
  } else {
    await notificationService.createNotification(submission.userId, {
      title: `Your ${kindLabel} submission was reviewed`,
      message: `"${submission.title}" was not approved. Admin note: ${cleanComment}`,
      type: 'general',
    });
  }

  logger.info(`Reward submission ${submissionId} (${submission.type}) resolved as ${status} by admin ${adminUid}`);
  return { ...submission, status, adminComment: cleanComment, reward: appliedReward, resolvedAt: Date.now(), resolvedByUid: adminUid };
}

module.exports = {
  submitVideo,
  submitBug,
  getUserSubmissions,
  adminListSubmissions,
  resolveSubmission,
};
