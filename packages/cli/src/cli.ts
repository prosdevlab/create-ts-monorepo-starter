#!/usr/bin/env node
import { wantsJson } from './args.js';
import { crashed, emitter } from './emit.js';
import { main } from './main.js';

const argv = process.argv.slice(2);
const out = emitter();

// Set the exit code instead of calling process.exit(), so pending output is flushed first.
main(argv, { emit: out.emit }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = crashed(error, wantsJson(argv), out);
  }
);
