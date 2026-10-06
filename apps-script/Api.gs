// Api.gs: web app entry points and the write pipeline (docs/05-api-contract.md).
// Milestone M2. Until then doGet answers a health check and doPost refuses every action.

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse_({ ok: true, data: { service: 'umsha-ledger', status: 'ok' } });
}

function doPost() {
  return jsonResponse_({ ok: false, code: 'E_INTERNAL', message: 'The server is not ready yet.' });
}
