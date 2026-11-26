// utils/phonepeChecksum.js
// PhonePe Checksum Generation
// Converted from checksum_my.php

const crypto = require('crypto');

// Random string generator
const randomString = (length, chars = '0123456789abcdef') => {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
};

// Random number generator
const randomNumber = (length) => {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 10);
  }
  return result;
};

// Generate device fingerprint
const generateDeviceFingerprint = () => {
  const mom = randomString(16);
  const mon = randomString(64);
  const aa = crypto.createHash('sha256').update(randomNumber(19)).digest('hex').substring(0, 32);
  const aa2 = crypto.createHash('sha256').update(randomNumber(13)).digest('hex').substring(0, 32);

  return {
    deviceFingerprint: `${mom}c2RtNjM2-cWNvbQ-`,
    fingerprint: `${aa2}.${aa}.Xiaomi.${mon}`,
    raw: { mom, mon, aa, aa2 }
  };
};

// Generate checksum
const generateChecksum = (payload, endpoint) => {
  const timestamp = Date.now();
  const nonce = randomString(16);

  const dataToHash = `${endpoint}${payload}${timestamp}${nonce}`;
  const checksum = crypto.createHash('sha256').update(dataToHash).digest('base64');

  return {
    checksum,
    timestamp,
    nonce
  };
};

// Generate random IP
const generateRandomIP = () => {
  return `${Math.floor(Math.random() * 240) + 1}.${Math.floor(Math.random() * 240) + 1}.${Math.floor(Math.random() * 240) + 1}.${Math.floor(Math.random() * 240) + 1}`;
};

// Generate location
const generateLocation = () => {
  const latitude = (Math.random() * 15 + 10).toFixed(6);
  const longitude = (Math.random() * 53 + 27).toFixed(6);

  return { latitude, longitude };
};

module.exports = {
  randomString,
  randomNumber,
  generateDeviceFingerprint,
  generateChecksum,
  generateRandomIP,
  generateLocation
};
