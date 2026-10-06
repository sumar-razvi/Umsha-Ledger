// core/receipts.js: what a customer receipt or invoice says, and the
// WhatsApp message that goes with it (docs/06 WhatsApp). The page renders the
// printable view; this decides the content.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.

const Money = require('./money.js');
const Validate = require('./validate.js');

const DEFAULT_TEMPLATE = 'Dear {name}, thank you. Received Rs {amount} for {docId}. Balance Rs {balance}. UMSHA';

function amount(paisa, settings) {
  return Money.formatPaisa(paisa, { symbol: '', grouping: (settings || {}).currencyGrouping });
}

// Replace {name}-style placeholders; unknown ones are left as typed.
function fillTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
}

// https://wa.me/923001234567?text=... (no number: WhatsApp asks whom to send to).
function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
}

function company(settings) {
  const s = settings || {};
  return { name: s.companyName || 'UMSHA', ntn: s.ntn || '', strn: s.strn || '' };
}

// Gross of an MTO order (quoted net + sales tax at the job's rate).
function orderGross(quotedNetPaisa, rateBps) {
  const net = Number(quotedNetPaisa || 0);
  return net + (rateBps ? Money.applyBps(net, rateBps) : 0);
}

// A receipt for money received from a customer: an advance on an order
// (job given) or a payment against an invoice (invoice given).
// args: {settings, payment, contact, job?, invoice?, balancePaisa}
function paymentReceipt(args) {
  const p = args.payment;
  const settings = args.settings || {};
  const contact = args.contact || {};
  const ref = args.invoice ? args.invoice.id : args.job ? args.job.id : '';
  const lines = [];
  if (args.job) lines.push({ label: 'Order ' + args.job.id + (args.job.title ? ': ' + args.job.title : ''), amountPaisa: null });
  if (args.invoice) lines.push({ label: 'Invoice ' + args.invoice.id, amountPaisa: args.invoice.grossPaisa });
  lines.push({ label: p.kind === 'CUSTOMER_ADVANCE' ? 'Advance received' : 'Payment received', amountPaisa: p.amountPaisa });
  const balance = Math.max(0, Number(args.balancePaisa || 0));
  const text = fillTemplate(settings.whatsappReceiptTemplate || DEFAULT_TEMPLATE, {
    name: contact.name || 'Customer', amount: amount(p.amountPaisa, settings), docId: ref || p.id,
    balance: amount(balance, settings), receiptNo: p.id, date: p.date,
  });
  return {
    kind: 'RECEIPT', title: 'Payment receipt', number: p.id, date: p.date, company: company(settings),
    to: { id: contact.id || '', name: contact.name || '', phone: contact.phone || '', city: contact.city || '' },
    reference: ref, lines: lines, amountPaisa: p.amountPaisa, balancePaisa: balance,
    method: p.moneyAccountName || '', currency: p.currency || '', fxAmount: p.fxAmount || '', fxRate: p.fxRate || '',
    whatsappText: text, whatsappUrl: whatsappUrl(contact.phone, text),
  };
}

// An MTO delivery invoice. args: {settings, invoice, lines, contact, job}
function invoiceDocument(args) {
  const inv = args.invoice;
  const settings = args.settings || {};
  const contact = args.contact || {};
  if (!inv) Validate.fail('E_NOT_FOUND', 'Invoice not found');
  const text = 'Dear ' + (contact.name || 'Customer') + ', your ' + company(settings).name + ' invoice ' + inv.id +
    ' is Rs ' + amount(inv.grossPaisa, settings) + '. Advance applied Rs ' + amount(inv.advanceAppliedPaisa || 0, settings) +
    '. Paid Rs ' + amount(inv.paidPaisa || 0, settings) + '. Balance Rs ' + amount(inv.balancePaisa || 0, settings) + '. Thank you.';
  return {
    kind: 'INVOICE', title: 'Invoice', number: inv.id, date: inv.date, dueDate: inv.dueDate || '', company: company(settings),
    to: { id: contact.id || '', name: contact.name || '', phone: contact.phone || '', city: contact.city || '' },
    reference: args.job ? args.job.id + (args.job.title ? ': ' + args.job.title : '') : '',
    lines: (args.lines || []).map(function (l) {
      return { label: l.description, qty: l.qty, unitPricePaisa: l.unitPricePaisa, discountPaisa: l.discountPaisa || 0, amountPaisa: l.netPaisa };
    }),
    netPaisa: inv.netPaisa, taxPaisa: inv.taxPaisa, grossPaisa: inv.grossPaisa,
    advanceAppliedPaisa: inv.advanceAppliedPaisa || 0, paidPaisa: inv.paidPaisa || 0, balancePaisa: inv.balancePaisa || 0,
    whatsappText: text, whatsappUrl: whatsappUrl(contact.phone, text),
  };
}

if (typeof module !== 'undefined') module.exports = {
  DEFAULT_TEMPLATE,
  fillTemplate,
  whatsappUrl,
  orderGross,
  paymentReceipt,
  invoiceDocument,
};
