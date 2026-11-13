# Billing Regression Checker

Replay a successful renewal followed by a delayed, older failure through a baseline handler and a candidate handler. **Run dry run** uses synthetic data entirely in memory. Optional saves and loads call a locally built `tool_redis` node through a bundled Tools > Redis pipeline. No model API key is needed.

## Verify in Local Preview

1. Open `billing_regression_checker.rrapp` in RocketRide App Builder and select Design > Preview using your existing Local Preview connection. The workspace watch serves this app on port 3883 and rebuilds on save.
2. Click **Run dry run**. The screen shows the computed verdict, both final access states, and each handler's access state after every delivery.
3. Confirm that the 10:05 UTC success arrives first (10:06), followed by the 10:00 failure (10:07). The baseline ends with access inactive and fails. The candidate ignores the older failure, keeps access active, and passes.
4. Run again to confirm that every replay starts from the same active state. Check the preview's light and dark themes and narrow viewport options.

## Save and verify from a fresh session

The connected local engine must load your locally built `tool_redis` node and its Redis Python dependency. Redis or Valkey must be reachable **from the engine**. The bundled `src/redis.pipe` defaults to `127.0.0.1:6381`, database 0, with the prefix `rr:billing-regression:v1:`. Edit the endpoint in that file for your local setup. The app does not install nodes or change the engine connection.

1. Run a dry run and scroll to **Saved results**. Writes start off after every page load or connection change.
2. Choose a result key, initially `renewal-demo`, then check **Enable writes for this session**. This toggle alone makes no Redis call.
3. Click **Save result**. Review the exact namespaced key, JSON payload, no-expiry policy, and create-only condition. Click **Approve and save** to permit one `redis_set` call. Cancel makes no write. Saving stores a result record only; it never changes subscription access.
4. Open a fresh preview session or reload the app. With writes still off and without running another dry run, enter the same result key and click **Load saved result**. It calls `redis_get`, validates the stored record, recomputes both handlers and the verdict, and shows the saved timestamp and both traces.
5. To save another run, choose a new key. `condition: 'NX'` atomically refuses an existing key. No record is silently overwritten. Records use `ttl_seconds: 0`, so they survive new app sessions while the Redis service retains its data. Persistence across Redis server restarts depends on that server's persistence configuration.

The prefix scopes this app's keys but is not a per-user authorization boundary. Anyone sharing the same Redis namespace and engine permissions can access the named demo records.

The app queries `client.getServices()` on the connected engine before storage operations. If `tool_redis` is absent, it gives a clear error directing you to an engine with your node installed. It also distinguishes missing records, invalid saved data, denied operations, pipeline startup failures, and unconfirmed writes. An unknown write outcome is never retried automatically; load the key to check it before approving another attempt.

A local production build verifies compilation only. Preview serves the watch's dev bundle, never `dist/`. Keep the generated Module Federation async boundary, HMR anchor, shared platform packages, and pinned build tooling intact.

## Replay model

`src/billingRegression.ts` owns the immutable synthetic fixture, two pure handlers, access traces, and verdict calculation. `src/App.tsx` renders a new replay after **Run dry run**, or renders a verified replay loaded from Redis. The dry-run path has no storage or LLM calls.

- Both handlers receive the same events in delivery order with independent initial states.
- The baseline applies every delivery. The candidate applies an event only when its occurrence timestamp is newer than the last applied timestamp.
- The expected state is computed independently from the latest event by occurrence time. Each handler passes only if its final access state matches that expected state. A newer failure therefore correctly expects inactive access.
- Equal timestamps keep the first occurrence. This is a deliberately simplified, single-subscription demo policy, not a production billing integration. Production ordering needs provider version semantics and an atomic check-and-write policy.
- Empty inputs, invalid timestamps, and mixed-subscription fixtures are rejected. Each click runs a fresh replay.

## Redis integration and Mithilesh's criteria

`src/ResultStorage.tsx` owns the session controls and approval dialog. `src/savedResults.ts` owns the storage contract, single-use approval gate, task tokens, serialization, and validation. `src/redis.pipe` wires a `tools` source to `tool_redis` over the tool control channel. The pipeline contains no agent or LLM.

1. The component obtains the existing shell client with `useShellConnection()`. Saves and loads call `client.tool({ token, nodeId: 'redis_1', tool, input })` directly, using only `redis_set` and `redis_get`. Read tokens and approved write tokens are separate. Active tokens are reused, expired tasks are restarted with `useExisting: true`, and tasks idle out after 900 seconds.
2. The bundled read pipeline has `allow_writes: false`. Only after explicit approval does the app start or reuse a separate write pipeline identity with `allow_writes: true`. Enabling writes, opening the dialog, and running a dry run do not start a write task. Approval is bound to the immutable proposal and consumed before any asynchronous work. Cancellation, changed results or keys, disabling writes, or reconnecting invalidates it. The gate is checked again immediately before `redis_set`. Disabling writes prevents further app writes; any already running task is left to its idle timeout. Approval controls this app, not arbitrary clients with independent engine access.
3. Saves are create-only with an atomic Redis NX condition, so an approval never overwrites changed underlying data. A failed or unconfirmed save consumes the approval and needs a fresh review before another attempt. Double-clicks cannot reuse an approval.
4. Schema version 1 stores a timestamp, ordered events, and the computed verdict and access summary. Loads validate the schema, input bounds, and summary against a fresh `runDryRun(events)` result. Persisted verdicts cannot override the code's computation. No browser storage or shell workspace state is used for saved results or write approval.
5. No LLM is called. A future optional LLM may receive the completed result to explain it only. It must have no Redis tools and cannot change the verdict or authorize writes.

## Checks

Use pnpm, preserving the server-vendored `shell` and `rocketride` file dependencies:

```sh
pnpm install
pnpm --dir apps/billing_regression_checker-ui test
pnpm --dir apps/billing_regression_checker-ui build
```

The tests use Node's built-in runner with TypeScript stripping (Node 22.6+). The 18 tests cover replay behavior plus default read-only behavior, exact and single-use approval, cancellation and changes during task startup, direct tool calls, separate read/write tasks, expired token recovery, a save/load round trip across separate store instances with a contract-faithful fake client, immutable NX saves, missing nodes, unknown write outcomes, and invalid records.

Platform guide: `.rocketride/docs/ROCKETRIDE_APPS.md`.

Verified in connected Local Preview on November 13, 2026: dry-run behavior, writes off by default, write opt-in, the exact save approval dialog, cancellation, and the live missing-node error. The currently connected stock engine does not advertise `tool_redis`, so a live Redis save/load round trip requires connecting the engine with your locally built node. No Redis writes were performed during UI verification. All 18 automated tests and the production build passed.
