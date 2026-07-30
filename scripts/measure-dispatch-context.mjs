#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../src/canonical-json.js';

function usage() {
  return [
    'Usage: node scripts/measure-dispatch-context.mjs',
    '  --packet <packet.json>',
    '  --role-wrapper <generated-role-file>',
    '  --activation-wrapper <generated-activation-file>',
    '  [--reference <canonical-file>]...',
  ].join(' ');
}

function parseArgs(argv) {
  const result = { references: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? 'argument'} requires a value`);
    if (flag === '--packet') result.packet = value;
    else if (flag === '--role-wrapper') result.roleWrapper = value;
    else if (flag === '--activation-wrapper') result.activationWrapper = value;
    else if (flag === '--reference') result.references.push(value);
    else throw new Error(`unknown option '${flag}'`);
  }
  for (const key of ['packet', 'roleWrapper', 'activationWrapper']) {
    if (!result[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`);
  }
  return result;
}

function bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

try {
  const options = parseArgs(process.argv.slice(2));
  const packetPath = resolve(options.packet);
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
  const components = [
    { kind: 'canonical_packet', path: packetPath, bytes: bytes(canonicalJson(packet)) },
    {
      kind: 'generated_role_wrapper',
      path: resolve(options.roleWrapper),
      bytes: bytes(readFileSync(resolve(options.roleWrapper), 'utf8')),
    },
    {
      kind: 'generated_activation_wrapper',
      path: resolve(options.activationWrapper),
      bytes: bytes(readFileSync(resolve(options.activationWrapper), 'utf8')),
    },
    ...options.references.map(reference => ({
      kind: 'canonical_reference',
      path: resolve(reference),
      bytes: bytes(readFileSync(resolve(reference), 'utf8')),
    })),
  ];
  const uniquePaths = new Set(components.map(component => component.path));
  if (uniquePaths.size !== components.length) throw new Error('the same context component was supplied more than once');
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    encoding: 'utf8',
    packetSerialization: 'canonicalJson',
    components,
    totalBytes: components.reduce((total, component) => total + component.bytes, 0),
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}\n`);
  process.exitCode = 2;
}
