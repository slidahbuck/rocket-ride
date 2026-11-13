import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineHandler, candidateHandler, runDryRun, SYNTHETIC_EVENTS } from '../src/billingRegression.ts';

test('delayed older failure revokes baseline access but candidate preserves renewal', () => {
	const result = runDryRun();
	assert.equal(result.expectedAccessActive, true);
	assert.equal(result.baseline.finalState.accessActive, false);
	assert.equal(result.baseline.passed, false);
	assert.equal(result.candidate.finalState.accessActive, true);
	assert.equal(result.candidate.passed, true);
	assert.equal(result.verdict, 'candidate-fixes-regression');
	assert.deepEqual(result.baseline.steps.map((step) => step.state.accessActive), [true, false]);
	assert.deepEqual(result.candidate.steps.map((step) => step.state.accessActive), [true, true]);
	assert.deepEqual(result.candidate.steps.map((step) => step.decision), ['applied', 'ignored-stale']);
	assert.deepEqual(result.candidate.steps.map((step) => step.event.id), SYNTHETIC_EVENTS.map((event) => event.id));
	assert.equal(result.candidate.finalState.lastAppliedOccurredAt, SYNTHETIC_EVENTS[0].occurredAt);
});

test('chronological deliveries pass for both handlers', () => {
	const result = runDryRun([
		{ ...SYNTHETIC_EVENTS[1], deliveredAt: '2026-11-13T10:01:00Z' },
		SYNTHETIC_EVENTS[0],
	]);
	assert.equal(result.verdict, 'both-pass');
	assert.deepEqual(result.candidate.steps.map((step) => step.state.accessActive), [false, true]);
});

test('a truly newer failure revokes access, so pass is not hardcoded to active', () => {
	const result = runDryRun([
		SYNTHETIC_EVENTS[0],
		{ ...SYNTHETIC_EVENTS[1], occurredAt: '2026-11-13T10:06:30Z' },
	]);
	assert.equal(result.expectedAccessActive, false);
	assert.equal(result.baseline.finalState.accessActive, false);
	assert.equal(result.candidate.finalState.accessActive, false);
	assert.equal(result.verdict, 'both-pass');
});

test('duplicate timestamps are ignored and first occurrence wins on a tie', () => {
	const result = runDryRun([
		SYNTHETIC_EVENTS[0],
		SYNTHETIC_EVENTS[0],
		{ ...SYNTHETIC_EVENTS[1], occurredAt: SYNTHETIC_EVENTS[0].occurredAt },
	]);
	assert.equal(result.candidate.finalState.accessActive, true);
	assert.deepEqual(result.candidate.steps.map((step) => step.decision), ['applied', 'ignored-stale', 'ignored-stale']);
	assert.equal(result.expectedAccessActive, true);
});

test('handlers do not mutate input state and reruns start independently', () => {
	const state = Object.freeze({ accessActive: true, lastAppliedOccurredAt: SYNTHETIC_EVENTS[0].occurredAt });
	const baseline = baselineHandler(state, SYNTHETIC_EVENTS[1]);
	const candidate = candidateHandler(state, SYNTHETIC_EVENTS[1]);
	assert.equal(state.accessActive, true);
	assert.notStrictEqual(baseline.state, state);
	assert.notStrictEqual(candidate.state, state);
	const first = runDryRun();
	const second = runDryRun();
	assert.deepEqual(first, second);
	assert.notStrictEqual(first.baseline.finalState, second.baseline.finalState);
	assert.notStrictEqual(first.baseline.steps[0].state, first.candidate.steps[0].state);
});

test('empty, invalid, or mixed-subscription fixtures cannot produce a passing verdict', () => {
	assert.throws(() => runDryRun([]), /at least one event/);
	assert.throws(() => runDryRun([{ ...SYNTHETIC_EVENTS[0], occurredAt: 'invalid' }]), /valid occurrence and delivery timestamps/);
	assert.throws(() => runDryRun([{ ...SYNTHETIC_EVENTS[0], deliveredAt: 'invalid' }]), /valid occurrence and delivery timestamps/);
	assert.throws(() => runDryRun([SYNTHETIC_EVENTS[0], { ...SYNTHETIC_EVENTS[1], subscriptionId: 'another_subscription' }]), /single subscription/);
});
