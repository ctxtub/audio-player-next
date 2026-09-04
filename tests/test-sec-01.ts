import assert from 'node:assert';
import { encodeSession, decodeSession } from '../lib/session';

process.env.SESSION_SECRET = 'test-secret';
const encoded = encodeSession(1, 'Alice');
assert(encoded !== btoa(JSON.stringify({ userId: 1, nickname: 'Alice' })), 'SEC-01: Session must not be just base64');
const decoded = decodeSession(encoded);
assert.deepStrictEqual(decoded, { userId: 1, nickname: 'Alice' }, 'SEC-01: Decode should work');
const tampered = encoded + 'x';
assert.strictEqual(decodeSession(tampered), null, 'SEC-01: Tampered session should return null');
console.log('SEC-01: PASS');
