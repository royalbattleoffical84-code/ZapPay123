// services/npciUpiService.js
// All UPI - NPCI UPI Complaint Portal Integration
const axios = require('axios');

const NPCI_BASE_URL = 'https://www.upihelp.npci.org.in';

// Browser-like headers
const getHeaders = (cookies = '') => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
  ...(cookies && { 'Cookie': cookies }),
});

// JSON API headers
const getApiHeaders = (cookies = '') => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Content-Type': 'application/json',
  'Origin': NPCI_BASE_URL,
  'Referer': NPCI_BASE_URL + '/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  ...(cookies && { 'Cookie': cookies }),
});

// Extract cookies from response
function extractCookies(response) {
  const setCookies = response.headers['set-cookie'] || [];
  const cookieMap = {};
  setCookies.forEach(c => {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k && v) cookieMap[k.trim()] = v.trim();
  });
  return Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Extract CSRF token from HTML
function extractCsrfToken(html) {
  // Try multiple patterns
  const patterns = [
    /csrf_token["']?\s*[:=]\s*["']([^"']+)/i,
    /csrf-token["']?\s*content=["']([^"']+)/i,
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)/i,
    /name=["']csrf_token["'][^>]*value=["']([^"']+)/i,
    /value=["']([^"']+)["'][^>]*name=["']csrf_token["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return '';
}

// Extract captcha URL from HTML
function extractCaptchaUrl(html) {
  // Try multiple patterns
  const patterns = [
    /src=["']([^"']*captcha[^"']*\.png[^"']*)["']/i,
    /src=["']([^"']*captcha[^"']*\.jpg[^"']*)["']/i,
    /src=["']([^"']*captcha[^"']*\.jpeg[^"']*)["']/i,
    /src=["']([^"']*captcha[^"']*\.gif[^"']*)["']/i,
    /src=["']([^"']*captcha[^"']*)["']/i,
    /url\(["']?([^"')]*captcha[^"')]*)["']?\)/i,
    /data-src=["']([^"']*captcha[^"']*)["']/i,
    /src=["']([^"']*captcha[^"']*\?[^"']*)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      let url = match[1];
      // Make absolute if relative
      if (url.startsWith('/')) {
        url = NPCI_BASE_URL + url;
      } else if (!url.startsWith('http')) {
        url = NPCI_BASE_URL + '/' + url;
      }
      return url;
    }
  }
  return '';
}

// Get Captcha — from homepage
const getCaptcha = async () => {
  try {
    console.log('Fetching NPCI homepage...');

    // Step 1: Get homepage
    const homeRes = await axios.get(NPCI_BASE_URL + '/', {
      headers: getHeaders(),
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    console.log('Homepage status:', homeRes.status);

    if (homeRes.status !== 200) {
      return {
        success: false,
        message: `NPCI returned status ${homeRes.status}`,
      };
    }

    const html = homeRes.data;
    const cookies = extractCookies(homeRes);

    console.log('Cookies extracted:', cookies ? 'yes' : 'no');

    // Step 2: Extract CSRF token
    const csrfToken = extractCsrfToken(html);
    console.log('CSRF token:', csrfToken ? 'found' : 'not found');

    // Step 3: Extract captcha URL
    const captchaUrl = extractCaptchaUrl(html);
    console.log('Captcha URL:', captchaUrl || 'not found');

    if (!captchaUrl) {
      // Try to find any image that might be captcha
      const imgMatch = html.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi);
      console.log('All images found:', imgMatch ? imgMatch.length : 0);

      return {
        success: false,
        message: 'Captcha image not found on page',
        debug: {
          hasCookies: !!cookies,
          csrfToken: csrfToken,
          htmlLength: html.length,
        },
      };
    }

    // Step 4: Fetch captcha image
    console.log('Fetching captcha from:', captchaUrl);

    const captchaRes = await axios.get(captchaUrl, {
      headers: {
        ...getHeaders(cookies),
        'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5',
        'Referer': NPCI_BASE_URL + '/',
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log('Captcha status:', captchaRes.status);

    if (captchaRes.status !== 200) {
      return {
        success: false,
        message: `Captcha fetch failed with status ${captchaRes.status}`,
      };
    }

    // Convert to base64
    const captchaBase64 = Buffer.from(captchaRes.data).toString('base64');
    const contentType = captchaRes.headers['content-type'] || 'image/png';

    console.log('Captcha loaded successfully');

    return {
      success: true,
      captchaImage: `data:${contentType};base64,${captchaBase64}`,
      captchaUrl: captchaUrl,
      csrfToken: csrfToken,
      cookies: cookies,
    };
  } catch (error) {
    console.error('NPCI getCaptcha error:', error.message);
    return { 
      success: false, 
      message: error.message || 'Failed to load captcha',
    };
  }
};

// Send OTP
const sendOtp = async (phone, upiId, captcha, cookies) => {
  try {
    console.log('Sending OTP to:', phone);

    // Step 1: Get fresh homepage for CSRF
    const homeRes = await axios.get(NPCI_BASE_URL + '/', {
      headers: getHeaders(cookies),
      timeout: 15000,
      validateStatus: () => true,
    });

    const html = homeRes.data;
    const freshCookies = extractCookies(homeRes) || cookies;
    const csrfToken = extractCsrfToken(html);

    console.log('CSRF for OTP:', csrfToken ? 'found' : 'not found');

    // Step 2: Send OTP
    const otpRes = await axios.post(NPCI_BASE_URL + '/auth/send-otp', {
      phone: phone,
      upi_id: upiId,
      captcha: captcha,
      csrf_token: csrfToken,
    }, {
      headers: getApiHeaders(freshCookies),
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log('OTP response status:', otpRes.status);

    // Update cookies
    const newCookies = extractCookies(otpRes) || freshCookies;

    if (otpRes.status === 200 || otpRes.status === 302) {
      return {
        success: true,
        csrfToken: csrfToken,
        cookies: newCookies,
        message: 'OTP sent successfully',
      };
    }

    return {
      success: false,
      message: otpRes.data?.message || `Failed to send OTP (status ${otpRes.status})`,
    };
  } catch (error) {
    console.error('NPCI sendOtp error:', error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.message || 'Network error',
    };
  }
};

// Validate OTP
const validateOtp = async (phone, upiId, otp, bankLast4, csrfToken, cookies) => {
  try {
    console.log('Validating OTP for:', phone);

    const validateRes = await axios.post(NPCI_BASE_URL + '/auth/validate-otp', {
      phone: phone,
      upi_id: upiId,
      otp: otp,
      bank_last4: bankLast4,
      csrf_token: csrfToken,
    }, {
      headers: getApiHeaders(cookies),
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log('Validate response status:', validateRes.status);

    if (validateRes.status === 200 && validateRes.data?.data) {
      return {
        success: true,
        session: {
          access_token: validateRes.data.data.access_token || '',
          refresh_token: validateRes.data.data.refresh_token || '',
          session_id: validateRes.data.data.session_id || '',
          user: validateRes.data.data.user || {},
        },
        message: 'UPI connected successfully',
      };
    }

    return {
      success: false,
      message: validateRes.data?.message || 'OTP validation failed',
    };
  } catch (error) {
    console.error('NPCI validateOtp error:', error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.message || 'Validation error',
    };
  }
};

module.exports = {
  getCaptcha,
  sendOtp,
  validateOtp,
};
