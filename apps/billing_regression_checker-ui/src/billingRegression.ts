/** Pure, in-memory replay. These functions never perform external writes. */
export interface BillingEvent {
	readonly id: string;
	readonly subscriptionId: string;
	readonly type: 'renewal.succeeded' | 'renewal.failed';
	readonly occurredAt: string;
	readonly deliveredAt: string;
}

export interface AccessState {
	readonly accessActive: boolean;
	readonly lastAppliedOccurredAt: string | null;
}

export interface HandlerStep {
	readonly event: BillingEvent;
	readonly decision: 'applied' | 'ignored-stale';
	readonly state: AccessState;
}

export type BillingHandler = (state: AccessState, event: BillingEvent) => HandlerStep;

export interface HandlerResult {
	readonly finalState: AccessState;
	readonly steps: readonly HandlerStep[];
	readonly passed: boolean;
}

export interface DryRunResult {
	readonly expectedAccessActive: boolean;
	readonly baseline: HandlerResult;
	readonly candidate: HandlerResult;
	readonly verdict: 'candidate-fixes-regression' | 'candidate-regresses' | 'both-pass' | 'both-fail';
}

export const SYNTHETIC_EVENTS: readonly BillingEvent[] = Object.freeze([
	Object.freeze({
		id: 'evt_renewal_success',
		subscriptionId: 'sub_demo_001',
		type: 'renewal.succeeded' as const,
		occurredAt: '2026-11-13T10:05:00Z',
		deliveredAt: '2026-11-13T10:06:00Z',
	}),
	Object.freeze({
		id: 'evt_older_failure',
		subscriptionId: 'sub_demo_001',
		type: 'renewal.failed' as const,
		occurredAt: '2026-11-13T10:00:00Z',
		deliveredAt: '2026-11-13T10:07:00Z',
	}),
]);

/** Deliberately vulnerable: an older delivery can overwrite a newer renewal. */
export const baselineHandler: BillingHandler = (_state, event) => ({
	event,
	decision: 'applied',
	state: {
		accessActive: event.type === 'renewal.succeeded',
		lastAppliedOccurredAt: event.occurredAt,
	},
});

/** Demo policy: ignore older events and keep the first event on timestamp ties. */
export const candidateHandler: BillingHandler = (state, event) => {
	if (state.lastAppliedOccurredAt !== null && Date.parse(event.occurredAt) <= Date.parse(state.lastAppliedOccurredAt)) {
		return { event, decision: 'ignored-stale', state: { ...state } };
	}
	return baselineHandler(state, event);
};

function replay(events: readonly BillingEvent[], handler: BillingHandler, expectedAccessActive: boolean): HandlerResult {
	let state: AccessState = { accessActive: true, lastAppliedOccurredAt: null };
	const steps = events.map((event) => {
		const step = handler(state, event);
		state = step.state;
		return step;
	});
	return { finalState: state, steps, passed: state.accessActive === expectedAccessActive };
}

/** The oracle is independent of either handler: select the latest occurrence. */
export function runDryRun(events: readonly BillingEvent[] = SYNTHETIC_EVENTS): DryRunResult {
	if (events.length === 0) throw new Error('A dry run requires at least one event.');
	for (const event of events) {
		if (!Number.isFinite(Date.parse(event.occurredAt)) || !Number.isFinite(Date.parse(event.deliveredAt))) {
			throw new Error('Every event must have valid occurrence and delivery timestamps.');
		}
		if (event.subscriptionId !== events[0].subscriptionId) {
			throw new Error('A dry run must contain events for a single subscription.');
		}
	}
	// Input order is delivery order. On equal timestamps the first occurrence wins.
	const latest = events.reduce((newest, event) => Date.parse(event.occurredAt) > Date.parse(newest.occurredAt) ? event : newest);
	const expectedAccessActive = latest.type === 'renewal.succeeded';
	const baseline = replay(events, baselineHandler, expectedAccessActive);
	const candidate = replay(events, candidateHandler, expectedAccessActive);
	const verdict = candidate.passed
		? baseline.passed ? 'both-pass' : 'candidate-fixes-regression'
		: baseline.passed ? 'candidate-regresses' : 'both-fail';
	return { expectedAccessActive, baseline, candidate, verdict };
}
