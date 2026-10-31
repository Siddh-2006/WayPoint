/**
 * server/src/contracts/check.test.ts
 *
 * Unit tests for pure checkRun contract validation.
 */

import { describe, expect, it } from 'vitest';
import { checkRun, type ContractDoc, type EventDoc } from './check.js';

describe('checkRun', () => {
  const contract: ContractDoc = {
    projectId: 'test-p',
    tool: 'create_invoice',
    requiredKeys: ['amount', 'invoiceId'],
    types: { invoiceId: ['string'], amount: ['number'] },
    support: { invoiceId: 1.0, amount: 1.0 },
  };

  it('passes cleanly when all required keys and types match', () => {
    const events: EventDoc[] = [
      {
        runId: 'r1',
        type: 'tool_call',
        status: 'ok',
        stepKey: 'create_invoice',
        contextPayload: {
          tool: 'create_invoice',
          args: { invoiceId: 'INV-100', amount: 450.0 },
        },
      },
    ];

    const violations = checkRun([contract], events);
    expect(violations).toHaveLength(0);
  });

  it('detects unexpected_similar_key when invoice_id is passed instead of invoiceId', () => {
    const events: EventDoc[] = [
      {
        runId: 'r1',
        type: 'tool_call',
        status: 'ok',
        stepKey: 'create_invoice',
        contextPayload: {
          tool: 'create_invoice',
          args: { invoice_id: 'INV-100', amount: 450.0 },
        },
      },
    ];

    const violations = checkRun([contract], events);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: 'unexpected_similar_key',
      expectedKey: 'invoiceId',
      found: 'invoice_id',
      message: 'key invoiceId missing; found invoice_id',
    });
  });

  it('detects missing_required_key when required key is completely missing', () => {
    const events: EventDoc[] = [
      {
        runId: 'r1',
        type: 'tool_call',
        status: 'ok',
        stepKey: 'create_invoice',
        contextPayload: {
          tool: 'create_invoice',
          args: { amount: 450.0 },
        },
      },
    ];

    const violations = checkRun([contract], events);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: 'missing_required_key',
      expectedKey: 'invoiceId',
    });
  });

  it('detects wrong_type when key has unexpected type', () => {
    const events: EventDoc[] = [
      {
        runId: 'r1',
        type: 'tool_call',
        status: 'ok',
        stepKey: 'create_invoice',
        contextPayload: {
          tool: 'create_invoice',
          args: { invoiceId: 12345, amount: 450.0 }, // invoiceId should be string
        },
      },
    ];

    const violations = checkRun([contract], events);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: 'wrong_type',
      expectedKey: 'invoiceId',
    });
  });
});

