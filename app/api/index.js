'use strict';

// Vercel serverless entry: every /api/* (plus /healthz and /metrics.json via
// rewrites) lands here; the Express app routes on the original URL.
module.exports = require('../server').app;
