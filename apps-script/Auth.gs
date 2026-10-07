// Auth.gs: who is calling. Verifies the Google ID token on every request
// (docs/05 Auth flow), then looks the email up in Users. Role checks are in
// Core.gs (Permissions.check), called by Api.gs.

var Auth = {
  TOKENINFO_URL: 'https://oauth2.googleapis.com/tokeninfo?id_token=',
  ISSUERS: ['accounts.google.com', 'https://accounts.google.com'],

  // ID token -> verified email (lower case). Cached 5 minutes by token hash.
  verify: function (idToken) {
    if (!idToken || typeof idToken !== 'string') throw Validate.coreError('E_AUTH', 'Please sign in.');
    var cache = CacheService.getScriptCache();
    var key = 'tok:' + Auth.sha256Hex_(idToken);
    var hit = cache.get(key);
    if (hit) return hit;

    var clientId = PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_ID');
    if (!clientId) throw Validate.coreError('E_INTERNAL', 'The OAUTH_CLIENT_ID script property is not set');
    var res = UrlFetchApp.fetch(Auth.TOKENINFO_URL + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw Validate.coreError('E_AUTH', 'Your sign-in has expired. Please sign in again.');
    var info = JSON.parse(res.getContentText());
    var now = Math.floor(Date.now() / 1000);
    if (info.aud !== clientId || Auth.ISSUERS.indexOf(info.iss) === -1 ||
        String(info.email_verified) !== 'true' || !(Number(info.exp) > now) || !info.email) {
      throw Validate.coreError('E_AUTH', 'Your sign-in could not be verified. Please sign in again.');
    }
    var email = String(info.email).toLowerCase();
    cache.put(key, email, Math.max(1, Math.min(300, Number(info.exp) - now)));
    return email;
  },

  // Verified email -> active Users row.
  userFor: function (email) {
    var user = Db.read('Users').filter(function (u) { return u.email === email && u.isActive; })[0];
    if (!user) throw Validate.coreError('E_AUTH', 'The account ' + email + ' does not have access. Ask the Owner to add you.');
    return user;
  },

  authenticate: function (idToken) {
    return Auth.userFor(Auth.verify(idToken));
  },

  sha256Hex_: function (s) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
    return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
  },
};
