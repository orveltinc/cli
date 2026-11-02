#!/usr/bin/env bun
import { runCli } from './cli';

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
// A consumer such as `head` may close the pipe early. Do not print a stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
process.exitCode = await runCli(process.argv.slice(2), {
  io: {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    signal: controller.signal,
  },
});
process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
