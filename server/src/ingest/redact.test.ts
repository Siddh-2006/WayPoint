/**
 * server/src/ingest/redact.test.ts
 *
 * Unit tests for the redact() function.  Runs with: pnpm test (vitest).
 */

import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact — key-based', () => {
  it('masks api_key values', () => {
    expect(redact({ api_key: 'sk-test123' })).toEqual({ api_key: '[REDACTED]' });
  });

  it('masks apiKey (camelCase) values', () => {
    expect(redact({ apiKey: 'secret' })).toEqual({ apiKey: '[REDACTED]' });
  });

  it('masks api-key (hyphenated) values', () => {
    expect(redact({ 'api-key': 'val' })).toEqual({ 'api-key': '[REDACTED]' });
  });

  it('masks password', () => {
    expect(redact({ password: 'hunter2' })).toEqual({ password: '[REDACTED]' });
  });

  it('masks authorization header value', () => {
    expect(redact({ authorization: 'Bearer tok' })).toEqual({
      authorization: '[REDACTED]',
    });
  });

  it('masks token', () => {
    expect(redact({ token: '12345' })).toEqual({ token: '[REDACTED]' });
  });

  it('masks secret', () => {
    expect(redact({ secret: 'shh' })).toEqual({ secret: '[REDACTED]' });
  });

  it('masks numeric values under sensitive keys', () => {
    expect(redact({ api_key: 42 })).toEqual({ api_key: '[REDACTED]' });
  });

  it('does not mask non-sensitive keys', () => {
    expect(redact({ model: 'gpt-4' })).toEqual({ model: 'gpt-4' });
  });
});

describe('redact — value-based patterns', () => {
  it('masks sk- style keys regardless of key name', () => {
    expect(redact({ llm_config: 'sk-abc123xyz' })).toEqual({
      llm_config: '[REDACTED]',
    });
  });

  it('masks Bearer tokens under any key', () => {
    expect(redact({ header: 'Bearer some.jwt.token' })).toEqual({
      header: '[REDACTED]',
    });
  });

  it('does not mask short strings that start with sk', () => {
    // "sk" alone or < 6 chars after sk- should not match
    expect(redact({ x: 'sk-ab' })).toEqual({ x: 'sk-ab' });
  });
});

describe('redact — nesting', () => {
  it('redacts inside nested objects', () => {
    const input = {
      level1: {
        level2: {
          api_key: 'sk-deep',
          safe: 'visible',
        },
      },
    };
    expect(redact(input)).toEqual({
      level1: {
        level2: {
          api_key: '[REDACTED]',
          safe: 'visible',
        },
      },
    });
  });

  it('redacts inside arrays', () => {
    expect(redact([{ password: 'x' }, { name: 'ok' }])).toEqual([
      { password: '[REDACTED]' },
      { name: 'ok' },
    ]);
  });

  it('leaves null / boolean values alone', () => {
    expect(redact({ a: null, b: true, c: false })).toEqual({
      a: null,
      b: true,
      c: false,
    });
  });

  it('handles an empty object', () => {
    expect(redact({})).toEqual({});
  });

  it('handles a string-only contextPayload', () => {
    // contextPayload is z.record(z.unknown()) — a plain string value is valid
    expect(redact({ note: 'hello world' })).toEqual({ note: 'hello world' });
  });

  it('handles deeply nested context without secrets', () => {
    const deep = { a: { b: { c: { d: { e: 'value' } } } } };
    expect(redact(deep)).toEqual(deep);
  });
});
