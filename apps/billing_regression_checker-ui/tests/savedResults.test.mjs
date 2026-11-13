import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runDryRun } from '../src/billingRegression.ts';
import { decodeSavedResult, MISSING_REDIS_NODE, SavedResults } from '../src/savedResults.ts';

const pipeline = JSON.parse(readFileSync(new URL('../src/redis.pipe', import.meta.url), 'utf8'));

function fixture(records = new Map()) {
	const calls = [];
	const tasks = new Map();
	const client = {
		async getServices() { calls.push({ method: 'getServices' }); return { services: { tools: {}, tool_redis: {} } }; },
		async getTaskStatus(token) { calls.push({ method: 'getTaskStatus', token }); return { completed: false, serviceUp: true, exitCode: 0 }; },
		async use(options) {
			calls.push({ method: 'use', ...options });
			const token = options.pipeline.project_id;
			tasks.set(token, options.pipeline);
			return { token };
		},
		async tool(options) {
			calls.push({ method: 'tool', ...options });
			const redis = tasks.get(options.token).components.find((node) => node.id === 'redis_1');
			const key = redis.config.key_prefix + options.input.key;
			if (options.tool === 'redis_get') return { success: true, found: records.has(key), value: records.get(key) ?? null };
			assert.equal(options.tool, 'redis_set');
			assert.equal(redis.config.allow_writes, true);
			assert.equal(options.input.condition, 'NX');
			assert.equal(options.input.ttl_seconds, 0);
			if (records.has(key)) return { success: true, stored: false };
			records.set(key, options.input.value);
			return { success: true, stored: true };
		},
	};
	return { client, calls, records, store: new SavedResults(client, pipeline) };
}

test('bundled Tools > Redis pipeline starts read-only and uses the tool control lane', () => {
	assert.equal(pipeline.source, 'tools_1');
	assert.equal(pipeline.components[0].provider, 'tools');
	const redis = pipeline.components[1];
	assert.equal(redis.provider, 'tool_redis');
	assert.equal(redis.config.allow_writes, false);
	assert.deepEqual(redis.control, [{ classType: 'tool', from: 'tools_1' }]);
	assert.equal(redis.config.key_prefix, 'rr:billing-regression:v1:');
});

test('dry run, writes off, and enabling writes never contact the engine', async () => {
	const { store, calls } = fixture();
	const result = runDryRun();
	assert.throws(() => store.prepareSave('test', result), /Enable writes/);
	await assert.rejects(store.saveApproved({ key: 'test', value: '{}' }), /fresh approval/);
	store.setWritesEnabled(true);
	const proposal = store.prepareSave('test', result);
	assert.ok(Object.isFrozen(proposal));
	assert.equal(proposal.fullKey, 'rr:billing-regression:v1:test');
	assert.deepEqual(calls, []);
});

test('only the exact approved proposal can write, once, directly through client.tool', async () => {
	const { store, calls } = fixture();
	store.setWritesEnabled(true);
	const proposal = store.prepareSave('test', runDryRun());
	await assert.rejects(store.saveApproved({ ...proposal }), /fresh approval/);
	assert.deepEqual(calls, []);
	const saving = store.saveApproved(proposal);
	await assert.rejects(store.saveApproved(proposal), /fresh approval/);
	await saving;
	const writes = calls.filter((call) => call.tool === 'redis_set');
	assert.equal(writes.length, 1);
	assert.equal(writes[0].nodeId, 'redis_1');
	assert.deepEqual(writes[0].input, { key: 'test', value: proposal.value, ttl_seconds: 0, condition: 'NX' });
	await assert.rejects(store.saveApproved(proposal), /fresh approval/);
	assert.equal(pipeline.components[1].config.allow_writes, false);
});

test('cancel, changed result or key, disabling writes, and disposal invalidate approvals', async () => {
	for (const change of [
		(store) => store.invalidateApproval(),
		(store) => store.prepareSave('other-key', runDryRun()),
		(store) => store.setWritesEnabled(false),
		(store) => store.dispose(),
	]) {
		const { store, calls } = fixture();
		store.setWritesEnabled(true);
		const proposal = store.prepareSave('test', runDryRun());
		change(store);
		await assert.rejects(store.saveApproved(proposal), /fresh approval/);
		assert.deepEqual(calls, []);
	}
});

test('disabling writes while the task is starting prevents redis_set', async () => {
	const { store, calls, client } = fixture();
	let release;
	client.getServices = () => new Promise((resolve) => { release = resolve; });
	store.setWritesEnabled(true);
	const saving = store.saveApproved(store.prepareSave('test', runDryRun()));
	store.setWritesEnabled(false);
	release({ services: { tools: {}, tool_redis: {} } });
	await assert.rejects(saving, /Save cancelled/);
	assert.equal(calls.filter((call) => call.method === 'tool').length, 0);
});

test('fresh session loads a saved result with writes off, recomputes verdict and all traces', async () => {
	const first = fixture();
	const original = runDryRun();
	first.store.setWritesEnabled(true);
	const proposal = first.store.prepareSave('renewal-demo', original);
	await first.store.saveApproved(proposal);
	const fresh = fixture(first.records);
	const loaded = await fresh.store.load('renewal-demo');
	assert.equal(loaded.key, 'renewal-demo');
	assert.equal(loaded.savedAt, proposal.savedAt);
	assert.deepEqual(loaded.result, original);
	assert.deepEqual(fresh.calls.filter((call) => call.method === 'tool').map((call) => call.tool), ['redis_get']);
	assert.equal(fresh.calls.find((call) => call.method === 'use').pipeline.components[1].config.allow_writes, false);
	assert.throws(() => fresh.store.prepareSave('test', original), /Enable writes/);
});

test('atomic NX refuses an existing key instead of overwriting it', async () => {
	const { store, records } = fixture();
	records.set(store.prefix + 'test', 'existing record');
	store.setWritesEnabled(true);
	await assert.rejects(store.saveApproved(store.prepareSave('test', runDryRun())), /already exists/);
	assert.equal(records.get(store.prefix + 'test'), 'existing record');
});

test('missing tool_redis is reported before pipeline creation or any tool call', async () => {
	const { store, client, calls } = fixture();
	client.getServices = async () => ({ services: { tools: {} } });
	await assert.rejects(store.load('test'), { message: MISSING_REDIS_NODE });
	store.setWritesEnabled(true);
	await assert.rejects(store.saveApproved(store.prepareSave('test', runDryRun())), { message: MISSING_REDIS_NODE });
	assert.deepEqual(calls, []);
});

test('read task tokens are reused, expired tasks restart, write tasks have a different identity', async () => {
	const { store, calls, client } = fixture();
	assert.equal(await store.load('missing'), null);
	await store.load('missing');
	assert.equal(calls.filter((call) => call.method === 'use').length, 1);
	client.getTaskStatus = async () => ({ completed: true, serviceUp: false, exitCode: 0 });
	await store.load('missing');
	assert.equal(calls.filter((call) => call.method === 'use').length, 2);
	store.setWritesEnabled(true);
	await store.saveApproved(store.prepareSave('new-result', runDryRun()));
	const uses = calls.filter((call) => call.method === 'use');
	assert.notEqual(uses[0].pipeline.project_id, uses.at(-1).pipeline.project_id);
	assert.ok(uses.every((call) => call.useExisting === true && call.ttl === 900));
});

test('unconfirmed and unknown writes are never retried and require fresh approval', async () => {
	for (const fail of [
		async () => { throw new Error('Disconnected'); },
		async () => ({ success: false, outcome: 'unknown', error_code: 'connection_error' }),
		async () => ({ success: true }),
	]) {
		const { store, client } = fixture();
		let attempts = 0;
		client.tool = async () => { attempts++; return fail(); };
		store.setWritesEnabled(true);
		const proposal = store.prepareSave('test', runDryRun());
		await assert.rejects(store.saveApproved(proposal), /Load saved result/);
		await assert.rejects(store.saveApproved(proposal), /fresh approval/);
		assert.equal(attempts, 1);
	}
});

test('malformed, changed-verdict and oversized saved records are rejected', () => {
	const { store } = fixture();
	store.setWritesEnabled(true);
	const proposal = store.prepareSave('test', runDryRun());
	const record = JSON.parse(proposal.value);
	const reject = (changes) => assert.throws(() => decodeSavedResult(JSON.stringify({ ...record, ...changes }), 'test'), /invalid|computed replay/);
	assert.throws(() => decodeSavedResult('not JSON', 'test'), /invalid/);
	assert.throws(() => decodeSavedResult('x'.repeat(65537), 'test'), /invalid/);
	reject({ schemaVersion: 2 });
	reject({ summary: { ...record.summary, verdict: 'both-pass' } });
	reject({ summary: { ...record.summary, baselineAccessActive: true } });
	reject({ events: [{ ...record.events[0], type: 'unsupported' }] });
	reject({ events: [{ ...record.events[0], occurredAt: 'invalid' }] });
	reject({ events: null });
});

test('invalid keys and node read failures cannot masquerade as a missing record', async () => {
	const { store, calls, client } = fixture();
	await assert.rejects(store.load('../other'), /result key/);
	assert.deepEqual(calls, []);
	client.tool = async () => ({ success: false, error_code: 'connection_error' });
	await assert.rejects(store.load('test'), /load failed/);
	client.tool = async () => ({ success: true, found: true, value: null });
	await assert.rejects(store.load('test'), /unreadable/);
	client.tool = async () => ({ success: false, error_code: 'permission_denied' });
	await assert.rejects(store.load('test'), /denied/);
});
