#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createBlockedResultRedelegation,
  createHumanDisposition,
} from '../src/blocked-result-authority.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { resolveWorkflowRoleRegistry } from '../src/workflow-roles.js';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new TypeError(
        'usage: sign-blocked-authority --request <request.json> --private-key <key.pem> ' +
        '--output <record.json> [--config <agenticloop.json>]'
      );
    }
    values[name.slice(2)] = value;
  }
  for (const required of ['request', 'private-key', 'output']) {
    if (!values[required]) throw new TypeError(`--${required} is required`);
  }
  return values;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const request = JSON.parse(readFileSync(resolve(args.request), 'utf8'));
  const privateKey = readFileSync(resolve(args['private-key']));
  const registry = args.config
    ? resolveWorkflowRoleRegistry(loadAgenticLoopConfig(resolve(args.config)))
    : undefined;
  const signing = {
    authorityId: request?.signing?.authorityId,
    keyId: request?.signing?.keyId,
    privateKey,
  };
  let record;
  if (request?.type === 'blocked_result_redelegation') {
    record = createBlockedResultRedelegation(
      { ...request.record, registry },
      signing
    );
  } else if (request?.type === 'human_disposition') {
    record = createHumanDisposition(
      { ...request.record, registry },
      signing
    );
  } else {
    throw new TypeError(
      "request.type must be 'blocked_result_redelegation' or 'human_disposition'"
    );
  }
  writeFileSync(resolve(args.output), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${resolve(args.output)}\n`);
} catch (error) {
  fail(error.message);
}
