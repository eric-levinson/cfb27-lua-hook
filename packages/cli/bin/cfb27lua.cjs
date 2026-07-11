#!/usr/bin/env node
'use strict';

const { main } = require('../src/main.cjs');

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
