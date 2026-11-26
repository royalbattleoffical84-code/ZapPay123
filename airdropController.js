const airdropService = require('../services/airdropService');
const response = require('../helpers/response');

const getStatus = async (req, res) => {
  try {
    const status = await airdropService.getClaimStatus(req.user.uid);
    return response.success(res, 'Status fetched', status);
  } catch (err) { return response.serverError(res, err.message); }
};

const claim = async (req, res) => {
  try {
    const coupon = await airdropService.claimWeeklyAirdrop(req.user.uid);
    return response.success(res, 'Airdrop claimed!', { coupon });
  } catch (err) {
    return response.error(res, err.message, err.alreadyClaimed ? 409 : 400);
  }
};

const listCoupons = async (req, res) => {
  try {
    const coupons = await airdropService.listMyCoupons(req.user.uid);
    return response.success(res, 'Coupons fetched', { coupons });
  } catch (err) { return response.serverError(res, err.message); }
};

module.exports = { getStatus, claim, listCoupons };
