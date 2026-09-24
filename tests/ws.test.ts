import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The Sec-WebSocket-Accept magic GUID is easy to typo and the only symptom is that every
 * real client silently refuses to connect, so pin it to the RFC 6455 §1.3 worked example.
 */
describe('websocket handshake', () => {
  it('computes the accept value from RFC 6455', () => {
    const src = readFileSync(new URL('../src/server/ws.ts', import.meta.url), 'utf8');
    const guid = src.match(/const GUID = '([^']+)'/)?.[1];
    expect(guid).toBeDefined();
    const accept = createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + guid).digest('base64');
    expect(accept).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});
