// config/staffPermissions.js
// Single source of truth for what a staff account can do.
//
// A staff login receives a token that acts on the OWNER's data (same uid),
// but middleware/auth.js runs every staff request through checkStaffAccess()
// below. It is DEFAULT-DENY: a route that is not listed here is owner-only.
// That means a new endpoint added later can never be reached by staff by
// accident — it has to be added to ROUTE_RULES on purpose.

const PERMISSIONS = {
  dashboard: {
    label: 'Dashboard & balance',
    desc: 'See the wallet balance, overview and notifications.',
    icon: 'bi-grid-fill',
  },
  transactions: {
    label: 'Transactions',
    desc: 'View payment history and check the status of an order.',
    icon: 'bi-clock-history',
  },
  payment_links: {
    label: 'Payment Links',
    desc: 'Create, edit, enable, disable and delete payment links.',
    icon: 'bi-link-45deg',
  },
  withdrawals_view: {
    label: 'Withdrawal history (view only)',
    desc: 'See past withdrawals. Staff can never request a withdrawal or change payout details.',
    icon: 'bi-arrow-up-right-circle',
  },
  promo: {
    label: 'Promo codes',
    desc: 'Create, edit and delete promo codes for customers.',
    icon: 'bi-ticket-perforated-fill',
  },
};

const PERMISSION_KEYS = Object.keys(PERMISSIONS);

// One-tap starting points in the "Add staff" form. The owner can still tick
// any combination — these only pre-fill the checkboxes.
const ROLE_PRESETS = [
  { id: 'support', label: 'Support Agent', permissions: ['dashboard', 'transactions'] },
  { id: 'accountant', label: 'Accountant', permissions: ['dashboard', 'transactions', 'withdrawals_view'] },
  { id: 'manager', label: 'Manager', permissions: ['dashboard', 'transactions', 'payment_links', 'withdrawals_view', 'promo'] },
  { id: 'marketing', label: 'Marketing', permissions: ['dashboard', 'promo', 'payment_links'] },
];

// [HTTP method or '*', RegExp tested against the path AFTER "/api", permission | null]
// null = any logged-in staff member (no specific permission needed).
const ROUTE_RULES = [
  ['GET', /^\/auth\/me$/, null],
  ['POST', /^\/auth\/logout$/, null],
  ['GET', /^\/subscription\/my$/, null],

  ['GET', /^\/wallet\/balance$/, 'dashboard'],
  ['GET', /^\/notification\/(count|list)$/, 'dashboard'],
  ['PUT', /^\/notification\/(read\/[^/]+|read-all)$/, 'dashboard'],

  ['GET', /^\/payment\/(history|status\/[^/]+)$/, 'transactions'],

  ['*', /^\/payment-link\/(create|list|[^/]+|[^/]+\/(disable|enable|edit))$/, 'payment_links'],

  ['GET', /^\/withdrawal\/history$/, 'withdrawals_view'],

  ['*', /^\/promo-manager\/(list|create|[A-Za-z0-9]+|[A-Za-z0-9]+\/redemptions)$/, 'promo'],
];

/**
 * @param {string} method       HTTP method
 * @param {string} apiPath      path after "/api", e.g. "/payment-link/list"
 * @param {string[]} granted    permissions on the staff record
 * @returns {{allowed: boolean, needs?: string|null}}
 */
function checkStaffAccess(method, apiPath, granted) {
  const path = String(apiPath || '').replace(/\/+$/, '') || '/';
  const m = String(method || '').toUpperCase();
  for (const [ruleMethod, re, perm] of ROUTE_RULES) {
    if (ruleMethod !== '*' && ruleMethod !== m) continue;
    if (!re.test(path)) continue;
    if (perm === null) return { allowed: true };
    return { allowed: Array.isArray(granted) && granted.includes(perm), needs: perm };
  }
  return { allowed: false, needs: null };
}

module.exports = { PERMISSIONS, PERMISSION_KEYS, ROLE_PRESETS, ROUTE_RULES, checkStaffAccess };
