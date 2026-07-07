#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { main } from './main.js';
import { DEBUG } from './src/core/config.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('\n  Fatal: ' + err.message);
    if (DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
