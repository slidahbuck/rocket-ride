import type { PipelineConfig, RocketRideClient } from 'rocketride';
import { runDryRun } from './billingRegression.ts';
import type { BillingEvent, DryRunResult } from './billingRegression.ts';

type RedisClient = Pick<RocketRideClient, 'getServices' | 'use' | 'getTaskStatus' | 'tool'>;
type RedisResponse = {
	success: boolean;
	error?: string;
	error_code?: string;
	outcome?: string;
	found?: boolean;
	value?: string | null;
	stored?: boolean;
};

export interface SaveProposal {
	readonly key: string;
	readonly fullKey: string;
	readonly value: string;
	readonly savedAt: string;
}

export interface LoadedResult {
	readonly key: string;
	readonly savedAt: string;
	readonly result: DryRunResult;
}

export const DEFAULT_RESULT_KEY = 'renewal-demo';
const WRITE_PROJECT_ID = '80f967db-ba2a-456d-94ac-19c4fe8ba45e';
const MAX_VALUE_BYTES = 65536;
export const MISSING_REDIS_NODE = 'The connected engine does not provide tool_redis (Redis). Connect Local Preview to your engine with the locally built Redis node installed, then try again. Run dry run still works in memory.';

function checkKey(key: string): string {
	if (!/^[A-Za-z0-9:_-]{1,100}$/.test(key)) {
		throw new Error('Use a result key of 1 to 100 letters, digits, colons, underscores, or hyphens.');
	}
	return key;
}

function summary(result: DryRunResult) {
	return {
		verdict: result.verdict,
		expectedAccessActive: result.expectedAccessActive,
		baselineAccessActive: result.baseline.finalState.accessActive,
		candidateAccessActive: result.candidate.finalState.accessActive,
		baselinePassed: result.baseline.passed,
		candidatePassed: result.candidate.passed,
	};
}

/** Validate saved input and recompute results. Never trust a persisted verdict. */
export function decodeSavedResult(value: string, key: string): LoadedResult {
	const invalid = () => new Error('The saved record is invalid or does not match the computed replay. Run a new dry run and save it under a new key.');
	if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) throw invalid();
	let record;
	try { record = JSON.parse(value); } catch { throw invalid(); }
	if (!record || record.schemaVersion !== 1 || record.scenario !== 'renewal-event-order'
		|| typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))
		|| !Array.isArray(record.events) || record.events.length < 1 || record.events.length > 100
		|| !record.summary || typeof record.summary !== 'object') throw invalid();
	const events: BillingEvent[] = record.events.map((event: unknown) => {
		if (!event || typeof event !== 'object') throw invalid();
		const item = event as Record<string, unknown>;
		for (const field of ['id', 'subscriptionId', 'occurredAt', 'deliveredAt']) {
			if (typeof item[field] !== 'string' || !item[field] || (item[field] as string).length > 256) throw invalid();
		}
		if (item.type !== 'renewal.succeeded' && item.type !== 'renewal.failed') throw invalid();
		return { id: item.id as string, subscriptionId: item.subscriptionId as string,
			type: item.type, occurredAt: item.occurredAt as string, deliveredAt: item.deliveredAt as string };
	});
	let result: DryRunResult;
	try { result = runDryRun(events); } catch { throw invalid(); }
	for (const [field, expected] of Object.entries(summary(result))) {
		if (record.summary[field] !== expected) throw invalid();
	}
	return { key, savedAt: record.savedAt, result };
}

/** App-owned storage and single-use approval. No model is in the execution path. */
export class SavedResults {
	private writesEnabled = false;
	private revision = 0;
	private pending: SaveProposal | null = null;
	private tokens = new Map<boolean, string>();
	private readonly readPipeline: PipelineConfig;
	private readonly client: RedisClient;
	readonly prefix: string;

	constructor(client: RedisClient, pipeline: PipelineConfig) {
		this.client = client;
		this.readPipeline = structuredClone(pipeline);
		const redis = this.readPipeline.components?.find((node) => node.id === 'redis_1' && node.provider === 'tool_redis');
		if (!redis?.config || typeof redis.config.key_prefix !== 'string' || redis.config.allow_writes !== false) {
			throw new Error('The bundled Redis pipeline must start read-only with a key prefix.');
		}
		this.prefix = redis.config.key_prefix;
	}

	setWritesEnabled(enabled: boolean) {
		this.writesEnabled = enabled;
		this.invalidateApproval();
	}

	invalidateApproval() {
		this.revision += 1;
		this.pending = null;
	}

	dispose() {
		this.setWritesEnabled(false);
		this.tokens.clear();
	}

	prepareSave(key: string, result: DryRunResult): SaveProposal {
		if (!this.writesEnabled) throw new Error('Enable writes before preparing a save.');
		checkKey(key);
		const savedAt = new Date().toISOString();
		const value = JSON.stringify({
			schemaVersion: 1, scenario: 'renewal-event-order', savedAt,
			events: result.baseline.steps.map((step) => step.event), summary: summary(result),
		});
		decodeSavedResult(value, key);
		this.invalidateApproval();
		this.pending = Object.freeze({ key, fullKey: this.prefix + key, value, savedAt });
		return this.pending;
	}

	private async token(write: boolean): Promise<string> {
		// Query the connected engine, never the workspace's possibly stale catalog.
		let services;
		try { services = (await this.client.getServices()).services; }
		catch { throw new Error('Could not inspect the connected engine. Check the RocketRide connection and try again.'); }
		if (!services?.tool_redis) throw new Error(MISSING_REDIS_NODE);
		if (!services.tools) throw new Error('The connected engine lacks the Tools source. Update the local engine to support Tools pipelines.');
		const cached = this.tokens.get(write);
		if (cached) {
			try {
				const status = await this.client.getTaskStatus(cached);
				if (!status.completed && status.serviceUp && status.exitCode === 0) return cached;
			} catch { /* Expired or restarted task. Reattach on the next use call. */ }
			this.tokens.delete(write);
		}
		const pipeline = structuredClone(this.readPipeline);
		if (write) {
			pipeline.project_id = WRITE_PROJECT_ID;
			pipeline.components!.find((node) => node.id === 'redis_1')!.config!.allow_writes = true;
		}
		try {
			const { token } = await this.client.use({ pipeline, useExisting: true, ttl: 900, pipelineTraceLevel: 'none' });
			if (!token) throw new Error('No task token');
			this.tokens.set(write, token);
			return token;
		} catch {
			throw new Error('Could not start Tools > Redis. Check that the local tool_redis node loads correctly and Redis or Valkey is reachable at the endpoint in redis.pipe.');
		}
	}

	private async tool(token: string, name: 'redis_get' | 'redis_set', input: Record<string, unknown>): Promise<RedisResponse> {
		let response: RedisResponse;
		try { response = await this.client.tool<RedisResponse>({ token, nodeId: 'redis_1', tool: name, input, timeout: 30000 }); }
		catch {
			this.tokens.clear();
			throw new Error(name === 'redis_set'
				? 'The save could not be confirmed and may have been applied. Use Load saved result to check this key before retrying. No automatic retry was made.'
				: 'Redis could not read the result. Check the engine and Redis connection, then try again.');
		}
		if (!response || response.success !== true) {
			if (response?.outcome === 'unknown' && name === 'redis_set') {
				throw new Error('The Redis write outcome is unknown. Use Load saved result to check this key before retrying. No automatic retry was made.');
			}
			if (response?.error_code === 'permission_denied') throw new Error('The Redis node or Redis ACL denied this operation. Check allow_writes on the approved write task and the Redis permissions.');
			throw new Error(`Redis ${name === 'redis_set' ? 'save' : 'load'} failed. Check the local Redis node and Redis connection.`);
		}
		return response;
	}

	async saveApproved(proposal: SaveProposal): Promise<void> {
		if (!this.writesEnabled || this.pending !== proposal) throw new Error('This save needs fresh approval with writes enabled.');
		// Consume before the first await, preventing double-clicks and replayed approvals.
		this.pending = null;
		const revision = this.revision;
		const token = await this.token(true);
		if (!this.writesEnabled || revision !== this.revision) throw new Error('Save cancelled because writes, the result, or the connection changed. Approve a new save.');
		const response = await this.tool(token, 'redis_set', {
			key: proposal.key, value: proposal.value, ttl_seconds: 0, condition: 'NX',
		});
		if (response.stored === false) throw new Error('This result key already exists. Nothing was overwritten. Load it, or choose a new key and approve a new save.');
		if (response.stored !== true) throw new Error('The save response was incomplete. Use Load saved result to verify the key before retrying.');
	}

	async load(key: string): Promise<LoadedResult | null> {
		checkKey(key);
		const token = await this.token(false);
		const response = await this.tool(token, 'redis_get', { key });
		if (response.found === false) return null;
		if (response.found !== true || typeof response.value !== 'string') throw new Error('Redis returned an unreadable saved result.');
		return decodeSavedResult(response.value, key);
	}
}
