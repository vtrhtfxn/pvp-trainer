import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from '../src/net/Client';

describe('server address', () => {
  it('accepts a bare IP, IP:port, the printed http:// address or a ws:// URL', () => {
    expect(normalizeServerUrl('192.168.1.23')).toBe('ws://192.168.1.23:4180/ws');
    expect(normalizeServerUrl(' 192.168.1.23:4181 ')).toBe('ws://192.168.1.23:4181/ws');
    expect(normalizeServerUrl('http://192.168.1.23:4180')).toBe('ws://192.168.1.23:4180/ws');
    expect(normalizeServerUrl('http://192.168.1.23:4180/')).toBe('ws://192.168.1.23:4180/ws');
    expect(normalizeServerUrl('ws://localhost:4180/ws')).toBe('ws://localhost:4180/ws');
    expect(normalizeServerUrl('https://pvp.example.com')).toBe('wss://pvp.example.com/ws');
  });
});
