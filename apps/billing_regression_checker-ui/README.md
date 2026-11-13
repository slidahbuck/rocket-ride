# Billing Regression Checker

Replay a successful renewal followed by a delayed, older failure through a baseline handler and a candidate handler. The first screen uses synthetic data entirely in memory, so it works in Local Preview without Redis, authentication, or a model API key.

## Verify in Local Preview

1. Open `billing_regression_checker.rrapp` in RocketRide App Builder and select Design > Preview using your existing Local Preview connection. The workspace watch serves this app on port 3883 and rebuilds on save.
2. Click **Run dry run**. The screen shows the computed verdict, both final access states, and each handler's access state after every delivery.
3. Confirm that the 10:05 UTC success arrives first (10:06), followed by the 10:00 failure (10:07). The baseline ends with access inactive and fails. The candidate ignores the older failure, keeps access active, and passes.
4. Run again to confirm that every replay starts from the same active state. Check the preview's light and dark themes and narrow viewport options.

A local production build verifies compilation only. Preview serves the watch's dev bundle, never `dist/`. Keep the generated Module Federation async boundary, HMR anchor, shared platform packages, and pinned build tooling intact.

## Replay model

`src/billingRegression.ts` owns the immutable synthetic fixture, two pure handlers, access traces, and verdict calculation. `src/App.tsx` renders the result after a button click. No shell persistence, external calls, or LLM is involved.

- Both handlers receive the same events in delivery order with independent initial states.
- The baseline applies every delivery. The candidate applies an event only when its occurrence timestamp is newer than the last applied timestamp.
- The expected state is computed independently from the latest event by occurrence time. Each handler passes only if its final access state matches that expected state. A newer failure therefore correctly expects inactive access.
- Equal timestamps keep the first occurrence. This is a deliberately simplified, single-subscription demo policy, not a production billing integration. Production ordering needs provider version semantics and an atomic check-and-write policy.
- Empty inputs, invalid timestamps, and mixed-subscription fixtures are rejected. Each click runs a fresh replay.

## Next step: Mithilesh's criteria

Redis integration is deferred until this screen is verified:

1. Obtain the shared shell client with `useShellConnection()`. The app calls Redis tools directly with `client.tool({ token, nodeId, tool, input })`; an LLM does not select or execute Redis operations. Reuse the pipeline task token for the session.
2. Show the precise proposed write, key, before/after values, and scope for a person to approve. A dry run never grants write approval. Every write must be explicitly approved, and approval must be invalidated if the proposal or underlying state changes. Enforce the condition atomically when writing.
3. Run the handlers and compute the verdict in deterministic application code. An optional LLM receives the completed results only to explain them. It has no write tools and cannot change the verdict or authorize a write.

## Checks

Use pnpm, preserving the server-vendored `shell` and `rocketride` file dependencies:

```sh
pnpm install
pnpm --dir apps/billing_regression_checker-ui test
pnpm --dir apps/billing_regression_checker-ui build
```

The tests use Node's built-in runner with TypeScript stripping (Node 22.6+). They cover the delayed failure, chronological events, a genuinely newer failure, duplicates and timestamp ties, repeatability, isolation, and invalid input.

Platform guide: `.rocketride/docs/ROCKETRIDE_APPS.md`.

Verified in the connected Local Preview on November 13, 2026: the initial ready state, button click, computed verdict, both access traces, and a keyboard rerun. All six replay tests and the production build passed.
