# pro-cli

<p align="center">
  <img src="assets/readme/pro-cli-hero.jpg" alt="Neon ChatGPT Pro interface globe for pro-cli" width="100%">
</p>

Agent native CLI for querying ChatGPT Pro and Deep Research through your own logged-in web session, managed from your terminal.

`pro-cli` gives coding agents a JSON-first command surface for the ChatGPT web account you already use: Pro models, thinking levels, Deep Research-style capabilities when available to your account, structured JSON outputs with schema validation, calibrated probability scoring, async jobs, and recoverable results.

`pro-cli` is built for legal ChatGPT subscribers using their own session. It does not bypass authentication, subscriptions, rate limits, access controls, or account restrictions.

## Install

Requires Bun. `pro-cli` is a Bun/TypeScript CLI with the binary name `pro-cli`. It has been tested on macOS; Windows may need install or Chrome auth command adjustment.

```sh
curl -fsSL https://raw.githubusercontent.com/ratacat/pro-cli/main/scripts/install.sh | bash
```

To choose the checkout path:

```sh
curl -fsSL https://raw.githubusercontent.com/ratacat/pro-cli/main/scripts/install.sh | PRO_INSTALL_DIR="$HOME/Projects/pro-cli" bash
```

The installer clones or fast-forwards `~/Projects/pro-cli`, runs `bun install`, runs `bun link`, and prints `pro-cli --version`. It does not touch auth, cookies, Chrome, or `~/.pro-cli`.

Update an existing clean install:

```sh
pro-cli update --json
```

`update` verifies the checkout is `main` with the expected origin and no uncommitted changes, then runs `git pull --ff-only origin main`, `bun install`, and `bun link`.

## Setup

`pro-cli` needs one logged-in ChatGPT Chrome window. `pro-cli` manages its local job daemon; you manage the browser login.

Choose one auth path; you do not need both. Both end with the same local `pro-cli` auth state.

**Agent-assisted auth: existing Chrome profile**

Use this when you are already logged in to ChatGPT in Chrome and trust the current agent with temporary local browser access:

```txt
I am logged in to ChatGPT in Chrome. Set up pro-cli auth from my existing Chrome profile. Store only scoped ChatGPT/OpenAI auth under ~/.pro-cli, do not print raw cookies or tokens, then verify with pro-cli doctor --json.
```

This is the lowest-friction path. It uses a browser profile that already has your ChatGPT session, so it also exposes that profile over Chrome DevTools Protocol while the CDP Chrome window is open.

**Manual auth: dedicated Chrome profile**

Use this when you want a separate browser profile for `pro-cli`:

```sh
pro-cli auth command --json
```

Run the returned Chrome command, sign in to ChatGPT in that window, then capture auth:

```sh
pro-cli auth capture --cdp http://127.0.0.1:9222 --json
pro-cli doctor --json
```

This is the normal long-running path. It creates `~/.pro-cli/chrome-profile`, keeps ChatGPT auth separate from your personal Chrome profile, and limits what the open debugging port can see.

Port `9222` is the default. If you use another port, pass the same `--cdp` or `--port` to `doctor`, `ask`, and `job create`. `job wait` uses the CDP value stored on the job.

## Runtime Model

Keep the ChatGPT Chrome window open while jobs run. `pro-cli` sends requests from that logged-in tab over Chrome DevTools Protocol, so it gets the same cookies, page session, frontend headers, and streaming/resume behavior as ChatGPT in the browser.

Async jobs run through a local `pro-cli` daemon. `job create`, `job wait`, and `job cancel` start or restart it when needed, so agents do not need to manage a background process. The daemon processes `~/.pro-cli/jobs.sqlite`; those commands reach it through a localhost control endpoint stored under `/tmp`.

Use the dedicated `~/.pro-cli/chrome-profile` window for normal operation. A personal Chrome profile can work, but the debugging port exposes that profile while it is open. The dedicated profile limits scope to ChatGPT.

If Chrome closes, run `pro-cli auth command --json` again. If ChatGPT logs out, sign in and rerun:

```sh
pro-cli auth capture --cdp <url> --json
```

When unsure, run:

```sh
pro-cli doctor --json
```

## Agent Instruction

Put this in a user-level or project-level agent instructions file:

```md
Use `pro-cli` to ask my ChatGPT Pro web account for hard questions, Pro thinking, Deep Research, or current model/tool capabilities. Prefer JSON and async jobs: `pro-cli job create @prompt.md --wait --json` for a blocking durable query, or `pro-cli job create @prompt.md --json`, `pro-cli job wait <job-id> --json`, and `pro-cli job result <job-id> --json` when you need separate steps. `pro-cli` defaults to `gpt-5-5-pro` with `standard` reasoning; pass `--reasoning extended` only when the prompt needs deeper Pro reasoning. `job create` and `job wait` manage the local daemon. When JSON output includes `data.result`, follow `data.agentInstruction`: preserve Pro's answer as the primary deliverable, relaying short results in full and condensing long results only with care for Pro's prose, structure, and voice. Do not add `--wait-timeout` unless you need a hard local command budget; a timeout means the job is still running, not failed. For a direct blocking query, use `pro-cli ask @prompt.md --json`. `pro-cli` requires the dedicated ChatGPT Chrome/CDP window to stay open; run `pro-cli doctor --json` first if unsure. If auth or the live browser is missing, run `pro-cli setup --json` and follow the returned commands. Never print, paste, or commit `~/.pro-cli`.
```

## Commands

Agents should use `--json`; non-TTY stdout switches to JSON automatically.

Setup and auth:

```sh
pro-cli setup --json
pro-cli update --json
pro-cli auth command --json
pro-cli auth capture --cdp http://127.0.0.1:9222 --json
pro-cli doctor --json
```

Models and defaults:

```sh
pro-cli models --json
pro-cli config get --json
pro-cli config set model gpt-5-5-pro --json
pro-cli config set reasoning extended --json
```

Async jobs:

```sh
pro-cli job create @prompt.md --json
pro-cli job create @prompt.md --wait --json
pro-cli job create @prompt.md --reasoning extended --json
pro-cli job wait <job-id> --json
pro-cli job wait <job-id> --soft-timeout 60000 --json
pro-cli job result <job-id> --json
pro-cli job cancel <job-id> --json
pro-cli job list --limit 20 --json
```

`job wait` without a timeout waits until the job succeeds, fails, or is cancelled. Long prompts and `--reasoning extended` can run for several minutes. Use `--soft-timeout <ms>` when an agent needs to poll without a nonzero exit. Use `--wait-timeout <ms>` only when a timeout should fail the local command.

Daemon:

```sh
pro-cli daemon status --json
pro-cli daemon restart --json
pro-cli daemon stop --json
```

Direct ask:

```sh
pro-cli ask @prompt.md --json
pro-cli ask @prompt.md --reasoning extended --json
```

`ask` executes without creating durable job state. Use `job create` when you need a job id that later `job wait`, `job result`, `job cancel`, or `job list` can inspect.

JSON responses that include full Pro text also include `agentInstruction` and `resultStats`. Agents should treat `data.result` as the primary deliverable. Results under 6000 characters should usually be relayed in full; longer results may be condensed with care for the original prose, structure, and voice.

Probability and plan:

```sh
pro-cli odds "Will X happen?" --context @evidence.md
pro-cli limits --json
```

## Structured Outputs

`pro-cli` wraps your prompt with strict JSON instructions, parses the model's reply, validates it, and retries on failure. Use this when an agent or script needs a typed result instead of prose.

Quick, with a free-form format hint:

```sh
pro-cli ask "Extract the people from this article" \
  --format '{people: [{name: string, role: string}]}'
```

Rigorous, with a JSON Schema (validates the parsed value):

```sh
pro-cli ask "Find 3 fictional spies" \
  --schema @people.schema.json --json
```

The CLI strips fenced ```` ```json ```` blocks (with a balanced-bracket fallback that handles braces inside strings), parses, and validates the root type plus top-level `required` fields. On parse or validation failure, it retries up to `--schema-retries <n>` times (default 1), feeding the previous failed response and the failure reason back to the model.

With `--json`, the envelope includes `parsed`, `raw`, and `attempts`. Without `--json`, the parsed JSON is pretty-printed to stdout, ready for `jq` or another tool. The same flags work on the durable job path:

```sh
pro-cli job create @prompt.md --wait --schema @file.json --json
```

## Probability Scoring

`pro-cli odds` is a yes/no probability assessor. It wraps your question with strict integer-only output instructions and returns a single integer 0–100 representing P(YES). Useful for prediction-market scoring, threshold gates in agent pipelines, or any place a calibrated number beats prose.

```sh
pro-cli odds "Will the deploy ship by Friday?" --context @evidence.md
# → 78

pro-cli odds "..." --samples 5 --aggregate median --json
```

Bare integer to stdout by default for shell-friendly consumption (`prob=$(pro-cli odds "...")`). `--samples N` runs N calls and aggregates (`mean` default; `median`, `trimmed-mean` available). `--allow-fifty` permits 50; the default forbids it to force a directional commitment, retrying up to `--parse-retries` if the model returns 50. `--json` returns the full envelope with per-sample attempts and job ids.

## Plan and Observed Limits

```sh
pro-cli limits --json
```

Returns:

- Plan facts from `accounts/check`: `plan_type`, `subscription_plan`, `expires_at`, `renews_at`, `billing_period`, `features`.
- Per-feature counters (e.g. `deep_research`, `odyssey`) captured from the ChatGPT stream metadata of recent `ask`/`odds`/`job` calls, with `observed_at` timestamps.

ChatGPT does not expose a standalone limits endpoint, so counters refresh whenever you make a real Pro call. General Pro chat throttling is adaptive and not exposed by any endpoint we found.

## Conversations

New `ask` and `job create` requests default to temporary ChatGPT conversations. Use `--save` when the turn should be written to ChatGPT history.

Continuing a conversation defaults to saved mode and requires both ids from the ChatGPT conversation:

```sh
pro-cli ask "follow up" --save --conversation <conversation-id> --parent <message-id> --json
```

## Thinking Modes

By default, `pro-cli` sends `--model gpt-5-5-pro --reasoning standard`. The request includes `thinking_effort=standard`, so it uses the Pro model rather than ChatGPT web's default picker.

For deeper Pro reasoning:

```sh
--reasoning extended
```

Use exact web effort values:

```txt
standard
extended
min
max
```

Pro models normally expose `standard` and `extended`. Thinking models may expose `min`, `standard`, `extended`, and `max`. For explicit model ids, use an effort shown by:

```sh
pro-cli models --json
```

## Request Controls

```sh
--model <id from pro-cli models>
--reasoning min|standard|extended|max
--cdp http://127.0.0.1:9222
--port 9222
--temporary
--save
--conversation <conversation-id>
--parent <message-id>
--verbosity low|medium|high
--instructions "system text"
--instructions-file prompt-system.txt
--reasoning-summary auto|concise|detailed|none
--tool-choice auto|none|required
--parallel-tools true|false
--timeout <ms>
--retries <0..5>
--retry-delay <ms>
--schema @schema.json | --schema "<inline JSON Schema>"
--format "<inline format hint>"
--schema-retries <0..5>
```

Probability (`odds`) only:

```sh
--context @evidence.md | --context "inline context"
--samples <1..25>
--aggregate mean|median|trimmed-mean
--parse-retries <0..5>
--allow-fifty
```

Job wait controls:

```sh
--wait
--soft-timeout <ms>
--wait-timeout <ms>
--poll-ms <ms>
```

Unsupported request flags fail loudly. Errors include `code`, `message`, and `suggestions`.

## Safety

`pro-cli` uses a browser session you control. The recommended setup opens a dedicated Chrome profile, captures scoped ChatGPT/OpenAI cookies plus the page session token, and stores them under `~/.pro-cli`.

Treat `~/.pro-cli` like SSH keys or browser session data. Do not commit it, paste it, sync it, or share it.

The daemon control file lives under `/tmp/pro-cli-*` with a local bearer token and private file mode. It points commands at the daemon; it does not contain ChatGPT cookies or session tokens.

If an older default `~/.pro` directory exists and `~/.pro-cli` does not, the first non-help command moves it to `~/.pro-cli` and rewrites stored paths that pointed inside the old directory. Set `PRO_CLI_HOME` to use a different location.

Normal setup, doctor, job, and status output redacts raw cookies and tokens. Files use private permissions where supported: `0600` for files and `0700` for directories. Requests go to `https://chatgpt.com`.
