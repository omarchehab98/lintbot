#!/usr/bin/env node
const lintbot = require('./lib/lintbot.js');
const { CLIEngine } = require('eslint');
process.on('unhandledRejection', error => console.error(error));
lintbot({ CLIEngine });
