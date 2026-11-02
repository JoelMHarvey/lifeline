'use strict';

// Structured JSON logs to stdout. Event names + metadata only — never message
// bodies or intake content. Logs are metadata-only by design, which is what
// makes AI-on-logs safe.
function log(event, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n'
  );
}

module.exports = { log };
