// routes/upload.js
//
// Proxies image uploads to imgbb so the imgbb API key never has to reach
// the client (a client-side fetch straight to imgbb would put the key in
// the browser's JS, visible to anyone via DevTools — this route exists
// purely to keep that key server-side only, same reasoning as the ZapAPI
// key never being logged, or FIREBASE_CLIENT_EMAIL/PRIVATE_KEY never
// shipping to the panel).
//
// Client sends a base64 data URL (from FileReader on their chosen file)
// as plain JSON — not multipart/form-data, since this backend has no
// multipart-parsing middleware (multer etc.) installed, and imgbb's own
// API already accepts a base64 `image` field directly, so no new
// dependency is needed to support this.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const firebaseService = require('../services/firebaseService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

// This route's body-size limit is set independently of the app-wide 1mb
// JSON limit (server.js) — a base64-encoded image is ~33% larger than
// its original binary size, so a modest logo image can exceed 1mb once
// encoded. Scoped to just this route rather than raising the global
// limit, so the rest of the API surface doesn't gain a larger attack
// surface for oversized request bodies just to support this one feature.
const uploadBodyLimit = express.json({ limit: '8mb' });

/**
 * POST /api/upload/store-logo
 * Body: { imageBase64: "data:image/png;base64,..." }
 * Returns: { url: "https://i.ibb.co/..." }
 */
const handleImageUpload = async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return response.error(res, 'No image provided', 400);
    }

    // Strip the "data:image/png;base64," prefix if present — imgbb's API
    // wants the raw base64 payload only, not the full data URL.
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    // Rough size guard on the decoded payload (base64 length * 0.75 ≈
    // decoded byte size) — rejects an oversized image with a clear
    // message before spending an outbound call to imgbb on it.
    const approxBytes = base64Data.length * 0.75;
    if (approxBytes > 5 * 1024 * 1024) {
      return response.error(res, 'Image must be under 5MB', 400);
    }

    const settings = await firebaseService.getSettings();
    const apiKey = settings.imgbbApiKey;
    if (!apiKey) {
      logger.error('Store logo upload attempted but no imgbbApiKey is configured in settings.');
      return response.error(res, 'Logo upload is not configured. Contact support.', 503);
    }

    const params = new URLSearchParams();
    params.append('key', apiKey);
    params.append('image', base64Data);

    const imgbbRes = await axios.post('https://api.imgbb.com/1/upload', params, {
      timeout: 20000,
    });

    const url = imgbbRes.data?.data?.url;
    if (!url) {
      logger.error('imgbb upload succeeded but returned no URL:', JSON.stringify(imgbbRes.data));
      return response.error(res, 'Upload failed — try again.', 502);
    }

    return response.success(res, 'Image uploaded', { url });
  } catch (err) {
    // imgbb's own error responses (bad key, quota, invalid image) come
    // back as err.response.data — surfaced in the log for diagnosis, but
    // not verbatim to the client, since imgbb's error text may reference
    // internal details (like confirming whether the key itself is valid)
    // that shouldn't leak to a merchant's browser.
    logger.error('Store logo upload error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return response.error(res, 'Upload failed — try again.', 502);
  }
};

router.post('/store-logo', authenticate, blockIfBanned, blockIfImpersonating, uploadBodyLimit, handleImageUpload);

/**
 * POST /api/upload/image
 * Same behaviour as /store-logo (base64 data URL in, hosted URL out) —
 * a neutral path for other features such as Bug Bounty screenshots.
 */
router.post('/image', authenticate, blockIfBanned, blockIfImpersonating, uploadBodyLimit, handleImageUpload);

module.exports = router;
