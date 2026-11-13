import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Card, ConfirmDialog, InputField, StatusBadge, useShellConnection, useShellEvent } from 'shell';
import type { DryRunResult } from './billingRegression';
import { DEFAULT_RESULT_KEY, SavedResults } from './savedResults';
import type { LoadedResult, SaveProposal } from './savedResults';
import redisPipeline from './redis.pipe';

const styles: Record<string, React.CSSProperties> = {
	body: { display: 'grid', gap: 16 },
	row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
	label: { display: 'grid', gap: 6, fontSize: 13, maxWidth: 420 },
	checkbox: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
	text: { margin: 0, color: 'var(--rr-text-secondary)', fontSize: 13 },
	mono: { fontFamily: 'var(--rr-font-mono, Consolas, monospace)', fontSize: 12, overflowWrap: 'anywhere' },
	preview: { margin: 0, padding: 12, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--rr-font-mono, Consolas, monospace)', fontSize: 11, background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 4 },
	heading: { margin: 0, fontSize: 18, fontWeight: 600 },
};

interface Props {
	result: DryRunResult | null;
	onLoad: (loaded: LoadedResult) => void;
	onBusyChange: (busy: boolean) => void;
}

export default function ResultStorage({ result, onLoad, onBusyChange }: Props) {
	const { client, isConnected } = useShellConnection();
	const [connectionVersion, setConnectionVersion] = useState(0);
	useShellEvent('shell:connected', () => setConnectionVersion((version) => version + 1));
	const store = useMemo(() => client && isConnected ? new SavedResults(client, redisPipeline) : null, [client, isConnected, connectionVersion]);
	const [key, setKey] = useState(DEFAULT_RESULT_KEY);
	const [writesEnabled, setWritesEnabled] = useState(false);
	const [proposal, setProposal] = useState<SaveProposal | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
	const operation = useRef(0);
	const inFlight = useRef(false);

	useEffect(() => {
		setWritesEnabled(false);
		setProposal(null);
		setMessage(null);
		setBusy(false);
		inFlight.current = false;
		onBusyChange(false);
		return () => { operation.current += 1; store?.dispose(); };
	}, [store, onBusyChange]);

	useEffect(() => { store?.invalidateApproval(); setProposal(null); }, [store, result]);

	function cancelApproval() {
		store?.invalidateApproval();
		setProposal(null);
	}

	function toggleWrites(enabled: boolean) {
		store?.setWritesEnabled(enabled);
		setWritesEnabled(enabled);
		setProposal(null);
		setMessage(null);
	}

	function prepareSave() {
		if (!store || !result) return;
		try { setProposal(store.prepareSave(key, result)); setMessage(null); }
		catch (error) { setMessage({ error: true, text: (error as Error).message }); }
	}

	async function perform(action: 'save' | 'load') {
		if (!store || inFlight.current || (action === 'save' && !proposal)) return;
		inFlight.current = true;
		const request = ++operation.current;
		setBusy(true);
		onBusyChange(true);
		setMessage(null);
		const approved = proposal;
		setProposal(null);
		try {
			if (action === 'save') {
				await store.saveApproved(approved!);
				if (request === operation.current) setMessage({ error: false, text: `Saved to Redis at ${approved!.fullKey}. Open a fresh session and load the same result key to verify it.` });
			} else {
				const loaded = await store.load(key);
				if (request !== operation.current) return;
				if (loaded) {
					onLoad(loaded);
					setMessage({ error: false, text: `Loaded ${store.prefix + key} from Redis. The verdict was recomputed from the saved events and verified against the saved summary.` });
				} else setMessage({ error: false, text: `No saved result exists at ${store.prefix + key}. Run a dry run, enable writes, and approve a save first.` });
			}
		} catch (error) {
			if (request === operation.current) setMessage({ error: true, text: (error as Error).message });
		} finally {
			if (request === operation.current) { setBusy(false); inFlight.current = false; onBusyChange(false); }
		}
	}

	return (
		<Card header={<h2 style={styles.heading}>Saved results</h2>} headerActions={<StatusBadge variant={writesEnabled ? 'warning' : 'muted'}>{writesEnabled ? 'Writes enabled' : 'Writes off'}</StatusBadge>}>
			<div style={styles.body}>
				<p style={styles.text}>Save this synthetic replay to your local Redis node, then load it from a fresh session. Dry runs never read or write Redis.</p>
				<label style={styles.label} htmlFor='billing-result-key'>Result key
					<InputField id='billing-result-key' value={key} maxLength={100} disabled={busy} onChange={(event) => { cancelApproval(); setKey(event.target.value); setMessage(null); }} />
				</label>
				<p style={styles.text}>Redis key: <code style={styles.mono}>{store?.prefix ?? 'rr:billing-regression:v1:'}{key}</code>. Records do not expire. Existing keys are never overwritten.</p>
				<label style={styles.checkbox}>
					<input type='checkbox' checked={writesEnabled} disabled={!store || busy} onChange={(event) => toggleWrites(event.target.checked)} />
					Enable writes for this session
				</label>
				<div style={styles.row}>
					<Button disabled={!store || !result || !writesEnabled || busy} onClick={prepareSave}>Save result</Button>
					<Button variant='secondary' disabled={!store || busy} onClick={() => { void perform('load'); }}>Load saved result</Button>
					{busy && <span role='status' style={styles.text}>Contacting Tools &gt; Redis...</span>}
				</div>
				{!store && <Banner variant='warning'>Connect RocketRide to your local engine to save or load. Run dry run remains available.</Banner>}
				{store && !result && <p style={styles.text}>Run a dry run to prepare a new save, or load an existing result now. Loading works with writes off.</p>}
				<div role={message?.error ? 'alert' : 'status'} aria-live={message?.error ? 'assertive' : 'polite'}>
					{message && <Banner variant={message.error ? 'error' : 'info'}>{message.text}</Banner>}
				</div>
			</div>
			{proposal && store && <ConfirmDialog
				title='Approve saving this result?'
				confirmLabel='Approve and save'
				confirmDisabled={!writesEnabled || busy}
				onCancel={cancelApproval}
				onConfirm={() => { void perform('save'); }}
				message={<div style={styles.body}>
					<p style={styles.text}>Create one record at <code style={styles.mono}>{proposal.fullKey}</code> using redis_set. It will not expire. The atomic NX condition prevents overwriting an existing record. This does not change billing access.</p>
					<p style={styles.text}>Approve only this exact payload. Cancel, a new run, a key change, disabling writes, or a connection change requires fresh approval.</p>
					<pre style={styles.preview}>{JSON.stringify(JSON.parse(proposal.value), null, 2)}</pre>
				</div>}
			/>}
		</Card>
	);
}
