// controllers/historyController.js
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

// All FamPay email times are IST. Server (Vercel) runs in UTC, so every
// conversion below is done explicitly against IST (+05:30) instead of
// relying on the server's local timezone.
const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "4:43 PM IST, 8 Oct 2026" -> real epoch ms (start of that minute)
function parseIstEmailTime(str) {
  if (!str) return null;
  const m = str.replace(/IST/i, '').match(/(\d{1,2}):(\d{2})\s*([AP])M\s*,?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  const mon = MONTH_IDX[m[5].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  return Date.UTC(parseInt(m[6], 10), mon, parseInt(m[4], 10), h, parseInt(m[2], 10)) - IST_OFFSET_MS;
}

// epoch ms -> "DD-MM-YYYY HH:mm:ss" in IST
function formatDate(ts) {
  const d = new Date(ts + IST_OFFSET_MS);
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Core IMAP fetch + parse, as a plain reusable function — connects to
 * the given mailbox, reads up to `limit` of the newest emails, and
 * extracts whatever looks like a FamPay payment-received notification
 * from each one.
 *
 * THIS is the single source of truth for "what a FamPay payment email
 * says" — both the merchant-facing "Live Email History" sync
 * (fetchHistory below, called via POST /api/history/fetch) and the
 * backend auto-verifier (services/fampayService.js) call this same
 * function, so they can never silently disagree about what's in the
 * mailbox. Previously they didn't: fampayService.js was calling a
 * function named `fetchFamPayHistory` that this file never actually
 * exported (only the differently-shaped, req/res-based `fetchHistory`
 * existed) — every verification attempt was throwing
 * "fetchFamPayHistory is not a function", getting caught, and silently
 * returning false, no matter how correct the matching logic around it
 * was. That mismatch, not any matching-logic bug, was the real cause of
 * "payment genuinely went through, verification says no" across every
 * attempt before this one.
 *
 * Returns { status: true, data: [...] } on success (data possibly
 * empty), or { status: false, error } if the mailbox couldn't be read
 * at all (bad credentials, connection failure, etc.) — callers must
 * treat `status: false` as "couldn't check", not "no payment found".
 */
async function fetchFamPayHistory(email, pass, limit = 15, opts = {}) {
  const fetchLimit = Math.min(Math.max(limit, 1), 50);

  const config = {
    imap: {
      user: email,
      password: pass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection;
  try {
    connection = await imap.connect(config);
    await connection.openBox('INBOX');

    // Two-phase fetch, mirroring the original purchased history.php
    // script's approach (which this Node version had drifted from and
    // was MUCH slower and less accurate for it):
    //
    // Phase 1 — a server-side-filtered, header-only search for
    // `SUBJECT "FamX account"` (the exact subject line FamPay's own
    // payment-received emails use). This is fast: Gmail's IMAP server
    // does the filtering and only returns matching UIDs + light
    // metadata, not any message content.
    //
    // Phase 2 — only the `fetchLimit` (default 15) most recent UIDs
    // from that filtered set get their full body fetched and parsed.
    //
    // The previous version searched `ALL` mail with `bodies: ['']` —
    // which, with imap-simple, fetches the FULL BODY of every single
    // message in the search result as part of the search call itself,
    // BEFORE any sorting/limiting happens. For any Gmail account with
    // more than a handful of emails ever (this account alone has
    // years of history), that meant downloading and parsing the
    // complete body of every message in the inbox on every single
    // call — easily tens of seconds to minutes, which is exactly why
    // this was timing out. It was also less accurate: without the
    // subject filter, the "does this look like a FamPay email" check
    // further down was a loose heuristic (any email mentioning
    // "received" and a rupee amount), which could pick up completely
    // unrelated emails.
    // SPEED: only look at recent mail (IMAP SINCE is day-granular, so go
    // back 1 extra day) instead of headers of every FamPay email ever
    // received, then fetch all needed bodies in ONE round trip and parse
    // them in parallel (was: one sequential IMAP round trip per email).
    const searchCriteria = [['SUBJECT', 'FamX account']];
    if (opts.sinceMs) searchCriteria.push(['SINCE', new Date(opts.sinceMs - 24 * 60 * 60 * 1000)]);
    const searchResults = await connection.search(searchCriteria, { bodies: ['HEADER'], struct: false, markSeen: false });
    searchResults.sort((a, b) => b.attributes.uid - a.attributes.uid);
    const limitedUids = searchResults.slice(0, fetchLimit).map((item) => item.attributes.uid);

    const parsedTransactions = [];

    let fetchedItems = [];
    if (limitedUids.length > 0) {
      fetchedItems = await connection.search([['UID', limitedUids.join(',')]], { bodies: [''], struct: true, markSeen: false });
      fetchedItems.sort((a, b) => b.attributes.uid - a.attributes.uid);
    }
    const parsedMails = await Promise.all(fetchedItems.map(async (item) => {
      const all = item.parts.find(part => part.which === '');
      if (!all) return null;
      try { return await simpleParser(all.body); } catch (e) { return null; }
    }));

    for (const mail of parsedMails) {
      if (!mail) continue;
      const subject = mail.subject || '';
      const body = mail.text || '';
      const dateFallback = mail.date;

      let amount = null, sender = 'NA', txn_id = 'NA', utr = 'NA', purpose = 'NA', txn_time = null, balance = null;

      const amtSubjMatch = subject.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
      if (amtSubjMatch) amount = parseFloat(amtSubjMatch[1].replace(/,/g, ''));

      // Account balance-after-transaction, as the original purchased
      // history.php script extracted it (e.g. "...your balance is
      // ₹59..."). Lost when this function replaced that PHP script —
      // this object never carried a `balance` field, which is exactly
      // why the FamPay Connect page's "FamPay Balance" stat went blank
      // even though everything else kept working.
      const balanceMatch = body.match(/balance\s+is\s+(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/i);
      if (balanceMatch) balance = parseFloat(balanceMatch[1].replace(/,/g, ''));

      const amtBodyMatch = body.match(/received\s+(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/i);
      if (amtBodyMatch) amount = parseFloat(amtBodyMatch[1].replace(/,/g, ''));

      const senderMatch = body.match(/from\s+([A-Za-z][A-Za-z0-9\s]{1,40}?)\s+at\s+\d/i);
      if (senderMatch) sender = senderMatch[1].trim();

      // Matches both "Transaction ID FMPIB..." (full prose, as seen in
      // some FamPay email bodies) and the app's own shorter "TXN ID:
      // FMPIB..." label — the earlier version of this regex only
      // matched the former, so FamPay-to-FamPay instant transfers
      // (which this account/app uses "TXN ID" for) were silently
      // parsed as txn_id: 'NA' even though the Live Email History UI,
      // which reads the same mailbox, clearly shows a TXN value for
      // them. "UTR" is intentionally excluded from this pattern so it
      // doesn't double-match the separate utr field below.
      const txnIdMatch = body.match(/\b(?:transaction\s*id|txn\s*\.?\s*id)[:\s]+([A-Z0-9]+)/i);
      if (txnIdMatch) txn_id = txnIdMatch[1];

      const utrMatch = body.match(/UTR[:\s]+(\d+)/i);
      if (utrMatch) utr = utrMatch[1];

      const timeMatch = body.match(/at\s+(\d{1,2}:\d{2}\s*[AP]M\s*IST,?\s*\d{1,2}\s+\w+\s+\d{4})/i);
      if (timeMatch) txn_time = timeMatch[1].trim();

      let finalDatetime = 'NA';
      let ts = null; // real epoch ms of the payment (minute precision when from body)
      if (txn_time) {
        ts = parseIstEmailTime(txn_time);
      }
      const mailTs = (dateFallback && !isNaN(new Date(dateFallback).getTime())) ? new Date(dateFallback).getTime() : null;
      if (ts === null && mailTs !== null) ts = mailTs;
      if (ts !== null) finalDatetime = formatDate(ts);

      if (amount && (subject.toLowerCase().includes('fam') || body.toLowerCase().includes('fam') || body.toLowerCase().includes('received'))) {
        parsedTransactions.push({ name: sender, utr, datetime: finalDatetime, ts, mailTs, amount, purpose, txn_id, balance });
      }
    }

    connection.end();
    return { status: true, data: parsedTransactions };
  } catch (error) {
    try { connection && connection.end(); } catch (_) {}
    logger.error('fetchFamPayHistory error:', error.message);
    return { status: false, error: error.message, data: [] };
  }
}

/**
 * POST /api/history/fetch — the merchant-facing "Live Email History"
 * sync button on the FamPay Connect page. Thin wrapper around
 * fetchFamPayHistory() above, plus the existing auto-sync-against-
 * pending-orders side effect (unchanged from before).
 */
const fetchHistory = async (req, res) => {
  const { email, pass, limit = 15 } = req.body;
  const userId = req.user?.uid;

  if (!email || !pass) {
    return response.error(res, 'Email and App Password are required.', 400);
  }

  const result = await fetchFamPayHistory(email, pass, limit);

  if (!result.status) {
    let friendlyError = 'Connection failed. Please check your credentials.';
    const errStr = (result.error || '').toLowerCase();
    if (errStr.includes('authenticationfailed') || errStr.includes('invalid credentials')) {
      friendlyError = 'Invalid App Password. Please check your Google App Password.';
    }
    return response.error(res, friendlyError);
  }

  const parsedTransactions = result.data;

  try {
    if (userId && parsedTransactions.length > 0) {
      const allOrdersSnap = await ref(DB_PATHS.PAYMENTS).orderByChild('userId').equalTo(userId).once('value');
      const usedIdentifiers = new Set();
      const pendingOrders = [];

      if (allOrdersSnap.exists()) {
        allOrdersSnap.forEach(child => {
          const o = child.val();
          if (o.status === 'success') {
            if (o.utr && o.utr !== 'NA') usedIdentifiers.add(o.utr);
            if (o.txn_id && o.txn_id !== 'NA') usedIdentifiers.add(o.txn_id);
          } else if (o.status === 'pending') {
            pendingOrders.push({ id: child.key, ...o });
          }
        });
      }

      const availableTransactions = parsedTransactions.filter(tx => {
        const hasUtr = tx.utr !== 'NA' && usedIdentifiers.has(tx.utr);
        const hasTxn = tx.txn_id !== 'NA' && usedIdentifiers.has(tx.txn_id);
        return !hasUtr && !hasTxn;
      });

      for (const order of pendingOrders) {
        const matchIndex = availableTransactions.findIndex(tx => parseFloat(tx.amount) === parseFloat(order.amount));

        if (matchIndex !== -1) {
          const match = availableTransactions[matchIndex];
          availableTransactions.splice(matchIndex, 1); // Mark as used

          await firebaseService.updatePaymentStatus(order.id, {
            status: 'success',
            txn_id: match.txn_id !== 'NA' ? match.txn_id : 'AUTO_SYNC',
            utr: match.utr !== 'NA' ? match.utr : 'AUTO_SYNC',
            payerName: match.name !== 'NA' ? match.name : null,
            environment: 'email_auto_sync'
          });

          try {
            const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');
            const plan = subSnap.val()?.plan || { walletLimit: 500 };
            const balance = await walletService.getBalance(userId);
            const available = plan.walletLimit - balance;

            const credit = Math.min(order.amount, available);
            if (credit > 0) {
              await walletService.creditWallet(userId, credit, `Auto-Sync FamPay Order ${order.id}`);
            }

            const commissionPct = order.commissionPercent ?? plan.commissionPercent ?? 5;
            const creditCost = Math.round((order.amount * commissionPct) / 100 * 100) / 100;
            if (creditCost > 0) {
              try {
                await walletService.debitZapCredit(userId, creditCost, `Commission for Order ${order.id}`);
              } catch (e) {
                logger.error(`Zap Credit debit failed for already-verified order ${order.id}: ${e.message}`);
              }
            }
          } catch (e) {
            logger.error('Error crediting wallet during auto-sync:', e.message);
          }
        }
      }
    }
  } catch (e) {
    logger.error('fetchHistory auto-sync side effect error:', e.message);
  }

  return response.success(res, 'History synced', parsedTransactions);
};

// ─────────────────────────────────────────────────────────────────────
// AMAZON PAY WALLET — "You have added ₹X successfully to your Amazon Pay
// Wallet" notification emails (sender: Amazon Pay India).
//
// Unlike FamPay, this email states only an "Order Date" (no time of day),
// so the payment's timestamp is the email's own Date header — second
// precision, and always AFTER the payment itself. That is what lets the
// verifier reject any email that arrived before an order was created.
// ─────────────────────────────────────────────────────────────────────
// Only Amazon's own mail domains are trusted (stops look-alike senders such as
// amazon-fake.com from forging a wallet-credit email). Extend here if Amazon
// ever sends from another domain.
const AMAZON_SENDER_DOMAIN_RE = /(^|\.)(amazon|amazonpay)\.(in|com)$/i;

function amazonMailText(mail) {
  let t = mail.text || '';
  if (!t && mail.html) {
    t = String(mail.html)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|td|li|h\d)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#8377;/g, '₹');
  }
  return t.replace(/\s+/g, ' ').trim();
}

// Returns a normalized transaction, or null if this isn't a genuine
// Amazon Pay wallet-credit email (wrong sender, wrong shape, or missing
// any field verification depends on).
function parseAmazonMail(mail) {
  const fromAddr = String(mail.from?.value?.[0]?.address || '').toLowerCase();
  const domain = fromAddr.split('@')[1] || '';
  if (!AMAZON_SENDER_DOMAIN_RE.test(domain)) return null;

  const flat = amazonMailText(mail);
  if (!/Amazon Pay Wallet/i.test(flat) || !/UPI Reference ID/i.test(flat) || !/You have added/i.test(flat)) return null;

  // The deposited amount is ONLY the one in "You have added ₹X" — never
  // the "Updated Amazon Pay Balance" / Wallet / Gift Cards figures.
  const am = flat.match(/You have added\s*(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
  const ut = flat.match(/UPI Reference ID\s*[:\-]?\s*(\d{8,})/i);
  if (!am || !ut) return null;

  const mailTs = mail.date && !isNaN(new Date(mail.date).getTime()) ? new Date(mail.date).getTime() : null;
  if (mailTs === null) return null; // no usable timestamp => can't prove it isn't stale

  const od = flat.match(/Order Date\s*[:\-]?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const bal = flat.match(/Updated Amazon Pay Balance\s*(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);

  return {
    name: 'Amazon Pay',
    utr: ut[1],
    txn_id: ut[1],
    datetime: formatDate(mailTs),
    ts: mailTs,
    mailTs,
    tsPrecisionMs: 0, // exact (email Date header), unlike FamPay's minute-only time
    amount: parseFloat(am[1].replace(/,/g, '')),
    purpose: 'Amazon Pay Wallet',
    balance: bal ? parseFloat(bal[1].replace(/,/g, '')) : null,
    orderDate: od ? od[1] : null,
  };
}

/**
 * Amazon Pay counterpart of fetchFamPayHistory — same contract:
 * { status: true, data: [newest-first transactions] } or
 * { status: false, error } when the mailbox couldn't be read at all.
 */
async function fetchAmazonHistory(email, pass, limit = 15, opts = {}) {
  const fetchLimit = Math.min(Math.max(limit, 1), 50);
  const config = {
    imap: {
      user: email, password: pass, host: 'imap.gmail.com', port: 993, tls: true,
      authTimeout: 10000, tlsOptions: { rejectUnauthorized: false },
    },
  };

  let connection;
  try {
    connection = await imap.connect(config);
    await connection.openBox('INBOX');

    const criteria = [['OR', ['SUBJECT', 'added to your Amazon Pay Wallet'], ['SUBJECT', 'You have added']]];
    if (opts.sinceMs) criteria.push(['SINCE', new Date(opts.sinceMs - 24 * 60 * 60 * 1000)]);

    const found = await connection.search(criteria, { bodies: ['HEADER'], struct: false, markSeen: false });
    found.sort((a, b) => b.attributes.uid - a.attributes.uid);
    const uids = found.slice(0, fetchLimit).map((it) => it.attributes.uid);

    let items = [];
    if (uids.length > 0) {
      items = await connection.search([['UID', uids.join(',')]], { bodies: [''], struct: true, markSeen: false });
      items.sort((a, b) => b.attributes.uid - a.attributes.uid);
    }
    const mails = await Promise.all(items.map(async (item) => {
      const all = item.parts.find((part) => part.which === '');
      if (!all) return null;
      try { return await simpleParser(all.body); } catch (e) { return null; }
    }));

    const data = [];
    for (const mail of mails) {
      if (!mail) continue;
      const tx = parseAmazonMail(mail);
      if (tx) data.push(tx);
    }
    data.sort((a, b) => b.ts - a.ts);

    connection.end();
    return { status: true, data };
  } catch (error) {
    try { connection && connection.end(); } catch (_) {}
    logger.error('fetchAmazonHistory error:', error.message);
    return { status: false, error: error.message, data: [] };
  }
}

module.exports = { fetchHistory, fetchFamPayHistory, fetchAmazonHistory, parseAmazonMail };

