import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

if (process.env.ORVELT_KEYRING_SMOKE !== '1') {
  throw new Error('Refusing to access the native keychain. Set ORVELT_KEYRING_SMOKE=1 explicitly.');
}

const service = process.env.ORVELT_KEYRING_SMOKE_SERVICE ?? `orvelt-cli-smoke-${randomUUID()}`;
const name = process.env.ORVELT_KEYRING_SMOKE_NAME ?? `entry-${randomUUID()}`;
const phase = process.env.ORVELT_KEYRING_SMOKE_PHASE ?? 'roundtrip';
const { Entry } = await import('@napi-rs/keyring');
const value = JSON.stringify({
  server: 'https://keyring-smoke.invalid/v1',
  access_token: 'dummy-access-token',
  refresh_token: 'dummy-refresh-token',
});
const entry = new Entry(service, name);

if (phase === 'write') {
  entry.setPassword(value);
  console.log(JSON.stringify({ phase, service, name }));
} else if (phase === 'read') {
  assert.equal(entry.getPassword(), value, 'native keychain value differs across runtimes');
  console.log(JSON.stringify({ phase, service, name, matched: true }));
} else if (phase === 'delete') {
  entry.deletePassword();
  assert.equal(entry.getPassword(), null, 'native keychain entry was not deleted');
  console.log(JSON.stringify({ phase, service, name, deleted: true }));
} else if (phase === 'roundtrip') {
  try {
    entry.setPassword(value);
    assert.equal(entry.getPassword(), value);
    console.log(JSON.stringify({ phase, service, name, matched: true }));
  } finally {
    entry.deletePassword();
  }
} else {
  throw new Error(`Unknown ORVELT_KEYRING_SMOKE_PHASE: ${phase}`);
}
