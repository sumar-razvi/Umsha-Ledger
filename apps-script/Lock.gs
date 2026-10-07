// Lock.gs: one writer at a time (invariant 9). Every write runs inside the
// script lock; if another write holds it for more than 20 s the caller gets
// E_BUSY and the client retries with the same requestId.

var Lock = {
  WAIT_MS: 20000,

  run: function (fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Lock.WAIT_MS)) {
      throw Validate.coreError('E_BUSY', 'The system is busy saving something else. Please try again in a moment.');
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  },
};
