'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
execFileSync(process.execPath, ['--check', path.join(projectRoot, 'code.js')], { stdio: 'inherit' });
console.log('PASS: code.js syntax check');
