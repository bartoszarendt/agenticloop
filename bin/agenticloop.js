#!/usr/bin/env node
import { runCli } from '../src/cli-main.js';

const controller = new AbortController();
const onSigint = () => {
  if (!controller.signal.aborted) controller.abort();
};
process.on('SIGINT', onSigint);

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener('SIGINT', onSigint);
}
