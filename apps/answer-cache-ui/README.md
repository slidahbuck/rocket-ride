# Answer Cache

A RocketRide App Builder demo for the Redis tool node in [PR #3049](https://github.com/rocketride-org/rocketride-server/pull/3049). It checks Redis before making an answer and stores new answers with an expiration. The preview shows the answer source, remaining lifetime, and session hit rate.

## Open in VS Code

1. On macOS, install the RocketRide VS Code extension and open it once in Local mode so it downloads the engine. Have Node, pnpm, and Valkey or Redis available. This setup was verified with RocketRide extension 1.6.0 and engine 3.6.0. It uses an isolated Redis or Valkey instance listening on `127.0.0.1:6381`.
2. From the repository root, run:

   ```sh
   ./apps/answer-cache-ui/scripts/prepare-preview.sh
   ```

   The script keeps the preview engine in the foreground at `http://127.0.0.1:5565`. It copies the installed engine, adds the pinned Redis PR node to the copy, and starts a loopback Valkey or Redis process if one is not already available. Leave the terminal open. You can pass a checkout of the Redis PR as the first argument to use its local Git objects.
3. Open the repository root in VS Code. In RocketRide’s extension settings, select **Service** for the development connection and choose **Save & Reconnect** to use the Redis-enabled engine from step 2. Open [answer-cache.rrapp](answer-cache.rrapp) and select **Design → Preview**. To use RocketRide’s managed engine again, select **Local** in the same settings.

The App Builder downloads the matching platform packages and installs workspace dependencies. To build from a terminal after it does so, run `pnpm --filter local-answer-cache build` from the repository root.

## Demo in three requests

1. Leave **Sample answers** selected, pick a sample question, set **Lifetime for new entries** to **10 seconds**, and click **Ask question**. An uncached question shows **Cache miss** and **Loaded from samples**.
2. Click **Ask question** again before the countdown reaches zero. Look for **Cache hit** and **Served from Redis**. The hit reuses the answer without resetting its lifetime.
3. When the countdown shows **Expired**, click **Ask question** once more. Look for a new **Cache miss** and a fresh countdown. If a question was still warm from rehearsal, choose another one or wait for it to expire.

Sample answers use real Redis but do not call a model. For live Q&A, provide `ROCKETRIDE_GEMINI_KEY` in the engine's environment before launching the script, or point `ROCKETRIDE_DEMO_ENV_FILE` to a trusted, ignored shell environment file that sets it. Select **Gemini** in the preview, then enter your own question. A cache miss calls [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash); a hit returns the stored answer. The Redis sample flow was verified live. Gemini pipeline validation and the missing-key error were checked; a real model response requires a key.

## How it works

The app calls `redis_get` and `redis_set` on the PR node through the RocketRide client. The GET result includes remaining TTL. On a miss, the app selects a sample or runs a separate Gemini pipeline, then writes with a positive TTL and `NX` so another request cannot overwrite an entry it just filled. A concurrent miss can still generate twice. Failed model responses are never stored.

Cache keys are SHA-256 hashes of the question, separated by answer mode under `rr:answer-cache:demo:v1:`. Gemini questions are matched after trimming outer whitespace. Paraphrase matching, user isolation, rate limiting, and topic purge are outside this local demo. Do not enter sensitive questions in a shared preview.
