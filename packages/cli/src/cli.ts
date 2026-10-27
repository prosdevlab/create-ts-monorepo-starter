#!/usr/bin/env node
import { FAILURE, main } from './main.js';

// Set the exit code instead of calling process.exit(), so pending output is flushed first.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = FAILURE;
  }
);
