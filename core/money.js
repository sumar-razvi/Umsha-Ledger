// core/money.js: integer paisa arithmetic, parsing and formatting.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// All money is integer paisa (Rs 1,250.50 is 125050). Floats only appear at
// the UI edge, and never in arithmetic: products and quotients go through
// BigInt so large amounts times basis points cannot lose precision.

const BPS_DENOMINATOR = 10000;

function validationError(message, field) {
  const err = new Error(message);
  err.code = 'E_VALIDATION';
  if (field) err.field = field;
  return err;
}

function isPaisa(x) {
  return Number.isSafeInteger(x);
}

function assertPaisa(x, field) {
  if (!isPaisa(x)) {
    throw validationError((field || 'amount') + ' must be a whole number of paisa, got ' + x, field);
  }
  return x;
}

function toSafeNumber(big) {
  const n = Number(big);
  if (!Number.isSafeInteger(n)) throw validationError('Amount out of range: ' + big);
  return n;
}

// Round a Number to the nearest integer, ties to even (banker's rounding).
// For money, prefer divRoundHalfEven, which works on exact integers.
function roundHalfEven(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw validationError('roundHalfEven needs a finite number, got ' + x);
  }
  const f = Math.floor(x);
  const diff = x - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return r === 0 ? 0 : r; // normalise -0
}

// Exact integer division num / den rounded half-even. Inputs are integers
// (Number or BigInt); the result is a safe-integer Number.
function divRoundHalfEven(num, den) {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === BigInt(0)) throw validationError('Division by zero');
  if (d < BigInt(0)) { n = -n; d = -d; }
  let q = n / d;
  let r = n % d;
  if (r < BigInt(0)) { q -= BigInt(1); r += d; } // floor division
  const twice = BigInt(2) * r;
  if (twice > d || (twice === d && q % BigInt(2) !== BigInt(0))) q += BigInt(1);
  return toSafeNumber(q);
}

// amount × bps / 10000, rounded half-even. e.g. applyBps(10000000, 1800) = 1800000.
function applyBps(amountPaisa, bps) {
  assertPaisa(amountPaisa, 'amount');
  if (!Number.isSafeInteger(bps)) throw validationError('Rate must be whole basis points, got ' + bps, 'rateBps');
  return divRoundHalfEven(BigInt(amountPaisa) * BigInt(bps), BPS_DENOMINATOR);
}

// Parse a plain decimal (number or string, e.g. 2.5, "278.45") exactly into
// {units: BigInt, places}: 278.45 -> {units: 27845n, places: 2}. Throws when
// it has more than maxPlaces significant decimals.
function parseDecimal(value, maxPlaces, field) {
  let s;
  if (typeof value === 'number' && Number.isFinite(value)) s = String(value);
  else if (typeof value === 'string') s = value.trim().replace(/,/g, '');
  else throw validationError((field || 'value') + ' must be a number, got ' + value, field);
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw validationError((field || 'value') + ' must be a plain decimal number, got ' + value, field);
  }
  let frac = (m[3] || '').replace(/0+$/, '');
  if (frac.length > maxPlaces) {
    throw validationError((field || 'value') + ' allows at most ' + maxPlaces + ' decimal places, got ' + value, field);
  }
  const units = BigInt((m[1] || '') + (m[2] || '0') + frac);
  return { units: units, places: frac.length };
}

// value x 10^places as an exact safe integer: scaleDecimal(2.5, 3) = 2500.
function scaleDecimal(value, places, field) {
  const d = parseDecimal(value, places, field);
  return toSafeNumber(d.units * BigInt(10) ** BigInt(places - d.places));
}

// Foreign currency to paisa (R19): fxAmount (e.g. 1500.25 USD) x fxRate (PKR
// per unit, up to 6 decimals), rounded half-even to the paisa.
function fxToPaisa(fxAmount, fxRate) {
  const minor = BigInt(scaleDecimal(fxAmount, 2, 'fxAmount'));
  const rate = parseDecimal(fxRate, 6, 'fxRate');
  if (minor <= BigInt(0) || rate.units <= BigInt(0)) throw validationError('Foreign amount and rate must be positive', 'fxAmount');
  return divRoundHalfEven(minor * rate.units, BigInt(10) ** BigInt(rate.places));
}

// Turn weights into exact BigInts on a common scale. Weights are decimal
// numbers (e.g. 1, 1.5, 0.25) or, from callers that already scaled them, BigInts.
function scaleWeights(weights) {
  if (weights.every(function (w) { return typeof w === 'bigint'; })) {
    weights.forEach(function (w) {
      if (w < BigInt(0)) throw validationError('Weights must be non-negative', 'weights');
    });
    return weights.slice();
  }
  let maxDecimals = 0;
  const strs = weights.map(function (w, i) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw validationError('Weight ' + i + ' must be a non-negative number, got ' + w, 'weights');
    }
    const s = String(w);
    if (/e/i.test(s)) throw validationError('Weight ' + i + ' has too many decimal places: ' + w, 'weights');
    const dot = s.indexOf('.');
    const dec = dot === -1 ? 0 : s.length - dot - 1;
    if (dec > maxDecimals) maxDecimals = dec;
    return s;
  });
  return strs.map(function (s) {
    const dot = s.indexOf('.');
    const dec = dot === -1 ? 0 : s.length - dot - 1;
    const digits = s.replace('.', '') + '0'.repeat(maxDecimals - dec);
    return BigInt(digits);
  });
}

// Split an integer total across weights. Each share is rounded half-even and
// the rounding residual goes to the last line with a positive weight, so the
// shares always sum to exactly `total`.
// splitProRata(100, [1, 1, 1]) => [33, 33, 34]
function splitProRata(total, weights) {
  assertPaisa(total, 'total');
  if (!Array.isArray(weights) || weights.length === 0) {
    throw validationError('splitProRata needs at least one weight', 'weights');
  }
  const scaled = scaleWeights(weights);
  const sum = scaled.reduce(function (a, b) { return a + b; }, BigInt(0));
  if (sum === BigInt(0)) throw validationError('splitProRata needs at least one positive weight', 'weights');
  let residualIndex = -1;
  for (let i = scaled.length - 1; i >= 0; i--) {
    if (scaled[i] > BigInt(0)) { residualIndex = i; break; }
  }
  const big = BigInt(total);
  const shares = scaled.map(function (w) { return divRoundHalfEven(big * w, sum); });
  const allocated = shares.reduce(function (a, b, i) { return i === residualIndex ? a : a + b; }, 0);
  shares[residualIndex] = total - allocated;
  return shares;
}

// Rupee suffixes people type: 125k, 1.25L, 1.5 lakh, 2cr.
const SUFFIX_EXPONENTS = {
  k: 3, thousand: 3,
  l: 5, lac: 5, lacs: 5, lakh: 5, lakhs: 5,
  cr: 7, crore: 7, crores: 7,
};

// Parse what a user types into a rupee field and return paisa.
// Accepts "125000", "1,25,000", "Rs 1,250.50", "PKR 500", "125k", "1.25L",
// "-500", "(500)". Throws E_VALIDATION for anything else, including amounts
// more precise than one paisa (they are rejected, never silently rounded).
function parseRupees(input) {
  let s;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw validationError('Not a valid amount: ' + input);
    s = String(input);
  } else if (typeof input === 'string') {
    s = input;
  } else {
    throw validationError('Not a valid amount: ' + input);
  }
  const original = s;
  s = s.trim().toLowerCase().replace(/\s+/g, ' ');
  // One sign marker at most: "(500)", "-500", "-Rs 500" or "Rs -500".
  let signs = 0;
  if (/^\(.*\)$/.test(s)) { signs++; s = s.slice(1, -1).trim(); }
  if (s.charAt(0) === '-') { signs++; s = s.slice(1).trim(); }
  s = s.replace(/^(rs\.?|pkr|₨)\s*/, '');
  if (s.charAt(0) === '-') { signs++; s = s.slice(1).trim(); }
  if (signs > 1) throw validationError('Not a valid amount: ' + original);
  const negative = signs === 1;

  let exponent = 2; // rupees -> paisa
  const m = s.match(/^(.*?)\s*([a-z]+)$/);
  if (m) {
    const suffix = m[2];
    if (!Object.prototype.hasOwnProperty.call(SUFFIX_EXPONENTS, suffix)) {
      throw validationError('Not a valid amount: ' + original);
    }
    exponent += SUFFIX_EXPONENTS[suffix];
    s = m[1];
  }
  s = s.replace(/[, ]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) throw validationError('Not a valid amount: ' + original);

  const parts = s.split('.');
  const intPart = parts[0] || '0';
  let frac = parts[1] || '';
  if (frac.length > exponent) {
    const extra = frac.slice(exponent);
    if (/[^0]/.test(extra)) throw validationError('Amount is more precise than one paisa: ' + original);
    frac = frac.slice(0, exponent);
  }
  const digits = intPart + frac + '0'.repeat(exponent - frac.length);
  const value = toSafeNumber(BigInt(digits));
  return negative && value !== 0 ? -value : value;
}

function groupDigits(intStr, grouping) {
  if (grouping === 'INDIAN' && intStr.length > 3) {
    const last3 = intStr.slice(-3);
    const rest = intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return rest + ',' + last3;
  }
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Format paisa for display: formatPaisa(12500050) => "Rs 125,000.50".
// Options:
//   grouping: 'STANDARD' (125,000, default) | 'INDIAN' (1,25,000), from Settings.currencyGrouping
//   decimals: 'AUTO' (default: hide ".00" on whole rupees) | 'ALWAYS'
//   symbol:   prefix, default 'Rs ' ('' for table cells)
//   negative: 'MINUS' (default: "-Rs 500") | 'PARENS' ("(Rs 500)")
function formatPaisa(paisa, opts) {
  assertPaisa(paisa, 'amount');
  const o = opts || {};
  const grouping = o.grouping || 'STANDARD';
  const decimals = o.decimals || 'AUTO';
  const symbol = o.symbol === undefined ? 'Rs ' : o.symbol;
  const negativeStyle = o.negative || 'MINUS';

  const abs = Math.abs(paisa);
  const rupees = Math.floor(abs / 100);
  const cents = abs % 100;
  let body = groupDigits(String(rupees), grouping);
  if (decimals === 'ALWAYS' || cents !== 0) body += '.' + String(cents).padStart(2, '0');
  const text = symbol + body;
  if (paisa < 0) return negativeStyle === 'PARENS' ? '(' + text + ')' : '-' + text;
  return text;
}

// Plain rupee string with 2 decimals and no grouping, for CSV exports:
// toRupeeString(-125050) => "-1250.50".
function toRupeeString(paisa) {
  assertPaisa(paisa, 'amount');
  const abs = Math.abs(paisa);
  const s = Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
  return paisa < 0 ? '-' + s : s;
}

if (typeof module !== 'undefined') module.exports = {
  BPS_DENOMINATOR,
  validationError,
  isPaisa,
  assertPaisa,
  roundHalfEven,
  divRoundHalfEven,
  parseDecimal,
  scaleDecimal,
  fxToPaisa,
  applyBps,
  splitProRata,
  parseRupees,
  formatPaisa,
  toRupeeString,
};
