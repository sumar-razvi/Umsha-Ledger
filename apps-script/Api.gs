// Api.gs: the web app entry points and the write pipeline (docs/05).
//
//   verify token -> check role -> check Requests for requestId (replay if found)
//   -> acquire ScriptLock -> check Requests again -> run the action (load data,
//   build with Core.gs, validate, allocate IDs) -> AuditLog + Requests
//   -> commit all writes in one batch per tab -> release lock -> respond
//
// Nothing is written until the action has fully succeeded, so a failed
// request leaves the Sheet untouched and can simply be retried.

var KNOWN_CODES = ['E_AUTH', 'E_ROLE', 'E_BUSY', 'E_VALIDATION', 'E_NOT_FOUND', 'E_UNBALANCED', 'E_EMPTY_BRAND', 'E_NEG_AMOUNT',
  'E_PERIOD_LOCKED', 'E_INACTIVE_ACCOUNT', 'E_NEG_STOCK', 'E_JOB_CLOSED', 'E_OVERPAY', 'E_TAX_OVERRIDE_NO_REASON', 'E_INTERNAL'];

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse_({ ok: true, data: { service: 'umsha-ledger', status: 'ok' } });
}

function doPost(e) {
  var started = Date.now();
  var res;
  try {
    var body = e && e.postData && e.postData.contents;
    var req;
    try {
      req = JSON.parse(body || '');
    } catch (parseError) {
      throw Validate.coreError('E_VALIDATION', 'The request was not valid JSON');
    }
    res = Api.handle(req);
  } catch (err) {
    res = Api.errorEnvelope(err);
  }
  res.meta = Object.assign({}, res.meta || {}, { ms: Date.now() - started });
  return jsonResponse_(res);
}

var Api = {
  handle: function (req) {
    Db.reset();
    if (!req || typeof req !== 'object') throw Validate.coreError('E_VALIDATION', 'Empty request');
    var action = req.action;
    if (!Permissions.knownAction(action)) throw Validate.coreError('E_VALIDATION', 'Unknown action ' + action, 'action');
    var payload = req.payload && typeof req.payload === 'object' ? req.payload : {};
    var user = Auth.authenticate(req.idToken);
    Permissions.check(user, action, payload, Api.lookupsFor_(action, user));
    var handler = Actions[action];
    if (!handler) throw Validate.coreError('E_VALIDATION', 'This part of the system is not available yet', 'action');

    if (!Permissions.isWrite(action)) {
      return { ok: true, data: handler(payload, { user: user, action: action, today: Dates.karachiDate() }) };
    }

    var requestId = req.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
      throw Validate.coreError('E_VALIDATION', 'Every save needs a requestId', 'requestId');
    }
    var prior = Api.findRequest_(requestId);
    if (prior) return Api.replay_(prior, user, action);

    return Lock.run(function () {
      Db.reset(); // read fresh data now that we hold the lock
      var again = Api.findRequest_(requestId);
      if (again) return Api.replay_(again, user, action);
      var now = new Date();
      var tx = Db.begin();
      var env = { user: user, tx: tx, requestId: requestId, action: action, now: now, today: Dates.karachiDate(now), ts: Dates.karachiTimestamp(now) };
      var out = handler(payload, env) || {};
      Summaries.apply(tx); // dashboard caches, in the same lock and commit
      var res = { ok: true, data: out.data === undefined ? null : out.data };
      var audit = out.audit || {};
      tx.append('AuditLog', [{
        id: tx.nextDocId('AUD', env.today), ts: env.ts, userEmail: user.email, action: action,
        docType: audit.docType || '', docId: audit.docId || '', requestId: requestId, summary: audit.summary || action,
        before: audit.before === undefined ? '' : audit.before, after: audit.after === undefined ? '' : audit.after,
      }]);
      tx.append('Requests', [{ requestId: requestId, action: action, userEmail: user.email, ts: env.ts, responseJson: res }]);
      Db.commit(tx);
      Cache.bump();
      return res;
    });
  },

  findRequest_: function (requestId) {
    return Db.get('Requests', requestId);
  },

  // A repeated requestId returns the stored result (invariant 8) without posting again.
  replay_: function (prior, user, action) {
    if (prior.userEmail !== user.email || prior.action !== action) {
      throw Validate.coreError('E_VALIDATION', 'This requestId was already used for something else', 'requestId');
    }
    var res = typeof prior.responseJson === 'string' ? JSON.parse(prior.responseJson) : prior.responseJson;
    res.meta = Object.assign({}, res.meta || {}, { replayed: true });
    return res;
  },

  // Data some role rules need (Permissions.check), loaded only when needed.
  lookupsFor_: function (action, user) {
    if (user.role !== 'STORE') return {};
    if (action === 'expenses.create') return Validate.indexAccounts(Db.read('Accounts'));
    if (action === 'contacts.upsert') return { contacts: Db.byKey('Contacts') };
    return {};
  },

  errorEnvelope: function (err) {
    if (err && KNOWN_CODES.indexOf(err.code) >= 0) {
      var out = { ok: false, code: err.code, message: err.message };
      if (err.field) out.field = err.field;
      return out;
    }
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, code: 'E_INTERNAL', message: 'Something went wrong on the server. Nothing was saved. Please try again.' };
  },
};

// Report caches are keyed by a data version that every write bumps.
var Cache = {
  bump: function () {
    // Time plus a counter: unique even for two writes in the same millisecond.
    var c = CacheService.getScriptCache();
    var n = Number(String(c.get('dataVersion') || '').split('.')[1] || 0) + 1;
    c.put('dataVersion', Date.now() + '.' + n, 21600);
  },
  version: function () {
    return CacheService.getScriptCache().get('dataVersion') || '0';
  },
};
