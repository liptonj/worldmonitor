import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStartupRequestBudget } from '../src/app/startup-request-budget.ts';

describe('startup request budget', () => {
  it('consumes budget and blocks when exhausted', () => {
    const budget = createStartupRequestBudget(2);
    assert.equal(budget.tryConsume('news'), true);
    assert.equal(budget.tryConsume('markets'), true);
    assert.equal(budget.tryConsume('intelligence'), false);
  });

  it('returns true both times when tryConsume called with same task name twice (idempotent)', () => {
    const budget = createStartupRequestBudget(2);
    assert.equal(budget.tryConsume('news'), true);
    assert.equal(budget.tryConsume('news'), true);
  });

  it('remaining() decrements as tasks are consumed', () => {
    const budget = createStartupRequestBudget(3);
    assert.equal(budget.remaining(), 3);
    budget.tryConsume('a');
    assert.equal(budget.remaining(), 2);
    budget.tryConsume('b');
    assert.equal(budget.remaining(), 1);
    budget.tryConsume('c');
    assert.equal(budget.remaining(), 0);
  });

  it('remaining() returns 0 when budget exhausted (not negative)', () => {
    const budget = createStartupRequestBudget(2);
    budget.tryConsume('a');
    budget.tryConsume('b');
    budget.tryConsume('c'); // blocked
    assert.equal(budget.remaining(), 0);
  });
});
