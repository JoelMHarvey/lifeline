#!/usr/bin/env node
'use strict';

// npm test: the whole suite. Most test files exercise TELL's profile (its
// shift pattern, forms and wording are the reference data), so TL_PROFILE
// defaults to tell here; files about other profiles set their own.

const { spawnSync } = require('child_process');
const env = { ...process.env, TL_PROFILE: process.env.TL_PROFILE || 'tell' };
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(r.status === null ? 1 : r.status);
