// controllers/rewardController.js
const rewardService = require('../services/rewardService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const submitVideo = async (req, res) => {
  try {
    const record = await rewardService.submitVideo(req.user.uid, req.body);
    return response.success(res, 'Video submitted for review', { submission: record });
  } catch (err) {
    return response.error(res, err.message || 'Failed to submit video', 400);
  }
};

const submitBug = async (req, res) => {
  try {
    const record = await rewardService.submitBug(req.user.uid, req.body);
    return response.success(res, 'Bug report submitted for review', { submission: record });
  } catch (err) {
    return response.error(res, err.message || 'Failed to submit bug report', 400);
  }
};

const getMySubmissions = async (req, res) => {
  try {
    const submissions = await rewardService.getUserSubmissions(req.user.uid);
    return response.success(res, 'Submissions fetched', { submissions });
  } catch (err) {
    logger.error('getMySubmissions error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  submitVideo,
  submitBug,
  getMySubmissions,
};
