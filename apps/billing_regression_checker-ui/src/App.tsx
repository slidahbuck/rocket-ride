// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState } from 'react';
import { AppLayout, Button, Card, StatusBadge } from 'shell';
import type { ShellAppProps } from 'shell';
import { runDryRun, SYNTHETIC_EVENTS } from './billingRegression';
import type { DryRunResult, HandlerResult } from './billingRegression';
import ResultStorage from './ResultStorage';
import type { LoadedResult } from './savedResults';

const styles: Record<string, React.CSSProperties> = {
	page: {
		boxSizing: 'border-box', width: '100%', height: '100%', overflow: 'auto',
		background: 'var(--rr-bg-default)', color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family, system-ui)', fontSize: 14, lineHeight: 1.5,
	},
	content: { maxWidth: 1120, margin: '0 auto', padding: 'clamp(16px, 4vw, 40px)', display: 'grid', gap: 24 },
	header: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
	eyebrow: { color: 'var(--rr-text-secondary)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' },
	title: { margin: '6px 0 8px', fontSize: 'clamp(24px, 3vw, 32px)', fontWeight: 650, letterSpacing: '-0.025em', lineHeight: 1.2 },
	paragraph: { margin: 0, color: 'var(--rr-text-secondary)', maxWidth: 690 },
	scenario: { padding: 24, display: 'grid', gap: 16, borderLeft: '3px solid var(--rr-color-info)' },
	sectionTitle: { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em' },
	row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
	meta: { fontSize: 12, color: 'var(--rr-text-secondary)' },
	mono: { fontFamily: 'var(--rr-font-mono, Consolas, monospace)', fontSize: 12, overflowWrap: 'anywhere' },
	results: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 270px), 1fr))', gap: 16 },
	resultBody: { display: 'grid', gap: 12 },
	access: { margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em' },
	accessActive: { margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--rr-color-success)' },
	accessInactive: { margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--rr-color-error)' },
	verdict: { display: 'grid', gap: 4, padding: '16px 20px', background: 'var(--rr-bg-surface-alt)', border: '1px solid var(--rr-border)', borderRadius: 6 },
	verdictTitle: { margin: 0, fontSize: 16, fontWeight: 600 },
	tableScroll: { overflowX: 'auto' },
	table: { width: '100%', minWidth: 740, borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 },
	caption: { textAlign: 'left', padding: '12px 20px', color: 'var(--rr-text-secondary)', fontSize: 12 },
	th: { padding: '12px 20px', fontSize: 11, fontWeight: 600, color: 'var(--rr-text-secondary)', background: 'var(--rr-bg-surface-alt)', borderBottom: '1px solid var(--rr-border)' },
	td: { padding: '18px 20px', verticalAlign: 'top', borderBottom: '1px solid var(--rr-border)' },
	order: { fontFamily: 'var(--rr-font-mono, Consolas, monospace)', fontWeight: 600, color: 'var(--rr-color-info)' },
	cell: { display: 'grid', gap: 6, justifyItems: 'start' },
	time: { fontFamily: 'var(--rr-font-mono, Consolas, monospace)', whiteSpace: 'nowrap' },
	stale: { fontSize: 11, color: 'var(--rr-color-warning)' },
	note: { padding: '12px 20px', margin: 0, color: 'var(--rr-text-secondary)', fontSize: 12 },
	foot: { display: 'grid', gap: 8, paddingTop: 8, borderTop: '1px solid var(--rr-border)' },
};

function HandlerSummary({ name, description, result }: {
	name: string;
	description: string;
	result?: HandlerResult;
}) {
	return (
		<Card header={name} headerActions={
			<StatusBadge variant={!result ? 'muted' : result.passed ? 'success' : 'error'}>
				{!result ? 'Not run' : result.passed ? 'Pass' : 'Fail'}
			</StatusBadge>
		}>
			<div style={styles.resultBody}>
				<p style={styles.paragraph}>{description}</p>
				<p style={!result ? styles.access : result.finalState.accessActive ? styles.accessActive : styles.accessInactive}>
					{!result ? 'Awaiting dry run' : result.finalState.accessActive ? 'Access active' : 'Access inactive'}
				</p>
				<span style={styles.meta}>
					{!result ? 'Final access state appears here.' : `Kept access active: ${result.finalState.accessActive ? 'yes' : 'no'}`}
				</span>
			</div>
		</Card>
	);
}

function TraceCell({ result, index }: { result?: HandlerResult; index: number }) {
	const step = result?.steps[index];
	if (!step) return <span style={styles.meta}>Not run</span>;
	return (
		<div style={styles.cell}>
			<StatusBadge variant={step.state.accessActive ? 'success' : 'error'}>
				{step.state.accessActive ? 'Access active' : 'Access inactive'}
			</StatusBadge>
			<span style={styles.meta}>{step.decision === 'applied' ? 'Event applied' : 'Older event ignored'}</span>
		</div>
	);
}

const VERDICT_COPY: Record<DryRunResult['verdict'], { title: string; detail: string }> = {
	'candidate-fixes-regression': {
		title: 'Candidate passes: access stays active',
		detail: 'The baseline revokes access after the delayed failure. The candidate ignores that older event and preserves the successful renewal.',
	},
	'candidate-regresses': {
		title: 'Candidate fails: regression detected',
		detail: 'The baseline matches the expected access state, but the candidate does not.',
	},
	'both-pass': { title: 'Both handlers pass', detail: 'Both final access states match the latest event by occurrence time.' },
	'both-fail': { title: 'Both handlers fail', detail: 'Neither final access state matches the latest event by occurrence time.' },
};

const App: React.FC<ShellAppProps> = () => {
	const [result, setResult] = useState<DryRunResult | null>(null);
	const [runCount, setRunCount] = useState(0);
	const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
	const [storageBusy, setStorageBusy] = useState(false);
	const events = result?.baseline.steps.map((step) => step.event) ?? SYNTHETIC_EVENTS;

	function handleRun() {
		setResult(runDryRun());
		setRunCount((count) => count + 1);
		setLoadedFrom(null);
	}

	function handleLoad(loaded: LoadedResult) {
		setResult(loaded.result);
		setLoadedFrom(`Loaded from Redis: ${loaded.key}. Saved at ${loaded.savedAt}. Verdict recomputed in code.`);
	}

	return (
		<AppLayout>
			<main style={styles.page}>
				<div style={styles.content}>
					<header style={styles.header}>
						<div>
							<span style={styles.eyebrow}>Billing reliability / Event replay</span>
							<h1 style={styles.title}>Billing Regression Checker</h1>
							<p style={styles.paragraph}>Can a delayed failure undo a successful renewal? Replay the same events through two handlers and compare access.</p>
						</div>
						<StatusBadge variant='info'>Synthetic dry run</StatusBadge>
					</header>

					<Card noBodyPadding>
						<section style={styles.scenario} aria-labelledby='scenario-title'>
							<div style={styles.row}>
								<span style={styles.eyebrow}>Scenario</span>
								<code style={styles.mono}>sub_demo_001</code>
							</div>
							<h2 id='scenario-title' style={styles.sectionTitle}>Successful renewal, then an older failure</h2>
							<p style={styles.paragraph}>Access starts active. A renewal succeeds at 10:05 UTC. A failure from 10:00 UTC arrives afterward. Expected final state: access active.</p>
							<div style={styles.row}>
								<Button onClick={handleRun} disabled={storageBusy}>Run dry run</Button>
								<span style={styles.meta}>2 events · 2 handlers · In memory only</span>
							</div>
						</section>
					</Card>

					<div role='status' aria-live='polite' aria-atomic='true'>
						{result ? (
							<div style={styles.verdict}>
								<span style={styles.eyebrow}>{loadedFrom ? 'Verified saved result' : `Computed verdict / Run ${runCount} complete`}</span>
								{loadedFrom && <p style={styles.meta}>{loadedFrom}</p>}
								<h2 style={styles.verdictTitle}>{VERDICT_COPY[result.verdict].title}</h2>
								<p style={styles.paragraph}>{VERDICT_COPY[result.verdict].detail}</p>
							</div>
						) : <p style={styles.paragraph}>Ready to replay. Run the dry run to compute the verdict and both access traces.</p>}
					</div>

					<section style={styles.results} aria-label='Handler comparison'>
						<HandlerSummary name='Baseline handler' description='Applies every event in delivery order. The last delivery wins.' result={result?.baseline} />
						<HandlerSummary name='Candidate handler' description='Applies only newer events. Older or repeated timestamps are ignored.' result={result?.candidate} />
					</section>

					<Card header={<h2 style={styles.sectionTitle}>Event order & access trace</h2>} noBodyPadding>
						<div style={styles.tableScroll} tabIndex={0} role='region' aria-label='Event replay table, scroll horizontally on small screens'>
							<table style={styles.table}>
								<caption style={styles.caption}>Delivery order is preserved. All timestamps are in UTC.</caption>
								<thead><tr>
									{['Delivery', 'Synthetic event', 'Occurred / Delivered', 'Baseline after event', 'Candidate after event'].map((label) => (
										<th key={label} scope='col' style={styles.th}>{label}</th>
									))}
								</tr></thead>
								<tbody>{events.map((event, index) => (
									<tr key={event.id}>
										<td style={styles.td}><span style={styles.order}>{String(index + 1).padStart(2, '0')}</span></td>
										<th scope='row' style={styles.td}>
											<div style={styles.cell}>
												<span>{event.type === 'renewal.succeeded' ? 'Renewal succeeded' : 'Renewal failed'}</span>
												<code style={styles.mono}>{event.id}</code>
												{events.slice(0, index).some((prior) => Date.parse(prior.occurredAt) > Date.parse(event.occurredAt)) && <span style={styles.stale}>Older than a prior event</span>}
											</div>
										</th>
										<td style={styles.td}><div style={styles.cell}>
											<time style={styles.time} dateTime={event.occurredAt}>{event.occurredAt.replace('T', ' ').replace('Z', '')} occurred</time>
											<time style={styles.time} dateTime={event.deliveredAt}>{event.deliveredAt.replace('T', ' ').replace('Z', '')} delivered</time>
										</div></td>
										<td style={styles.td}><TraceCell result={result?.baseline} index={index} /></td>
										<td style={styles.td}><TraceCell result={result?.candidate} index={index} /></td>
									</tr>
								))}</tbody>
							</table>
						</div>
						<p style={styles.note}>Rule checked in code: the latest event by occurrence time determines access. Passing means the handler matches that state.</p>
					</Card>

					<ResultStorage result={result} onLoad={handleLoad} onBusyChange={setStorageBusy} />

					<footer style={styles.foot}>
						<p style={styles.meta}>This dry run uses synthetic events, makes no Redis calls, and does not call an LLM. Each run starts from the same active state.</p>
						<p style={styles.paragraph}>Saves and loads call Redis directly through <code style={styles.mono}>client.tool()</code>. Code decides the verdict. Any future LLM integration may explain the result only.</p>
					</footer>
				</div>
			</main>
		</AppLayout>
	);
};

export default App;
