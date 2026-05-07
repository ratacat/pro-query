# pro-cli

`pro-cli` installs the `pro` command: a local CLI for querying ChatGPT from a paid, logged-in web account.
It is built for developers and AI coding agents that need a scriptable terminal
interface without copying prompts into the browser.

The important constraints:

- you approve and control the browser session
- auth files stay on your machine under `~/.pro` by default
- raw cookies and tokens are not printed by status, jobs, or doctor commands
- requests go to `https://chatgpt.com`
- no runtime dependencies beyond Bun

## Status

This is an early local tool. It is not an official OpenAI API, and ChatGPT web
endpoints can change. `pro` is designed to fail loudly with structured errors
when auth expires, the web backend changes, or a stream is interrupted.

## Install

From source:

```sh
git clone https://github.com/ratacat/pro-query
cd pro-query
bun install
bun link
pro setup
```

For agents, use JSON from the start:

```sh
pro setup --json
```

## First Run

`pro setup` shows the current state and the next command to run. The safe path is
to use a dedicated Chrome profile for ChatGPT instead of exposing your normal
browser profile over CDP.

```sh
pro auth command
```

On macOS this prints a command like:

```sh
open -na "Google Chrome" --args --user-data-dir='~/.pro/chrome-profile' --remote-debugging-port=9222 https://chatgpt.com/
```

Then:

1. Open the printed Chrome command.
2. Sign in to ChatGPT in that Chrome window.
3. Capture auth:

```sh
pro auth capture --cdp http://127.0.0.1:9222 --json
pro doctor --json
```

Run a smoke query:

```sh
pro run "Reply with OK only." --reasoning low --verbosity low --json
```

## Daily Use

One-shot query:

```sh
pro run "Reply with OK only." --reasoning low --json
```

Prompt from a file:

```sh
pro run @prompt.md --model auto --reasoning medium --json
```

Async job:

```sh
pro submit @prompt.md --reasoning high --json
pro wait <job-id> --wait-timeout 60000 --json
pro result <job-id> --json
```

`submit` starts a detached worker by default and returns immediately. Pass
`--no-start` to only create a queued job. Worker logs are stored under
`~/.pro/workers/`.

## Request Controls

Supported controls are intentionally limited to fields validated against the
current ChatGPT backend:

```sh
--model auto|gpt-5.5|...
--reasoning auto|low|medium|high
--verbosity low|medium|high
--instructions "system text"
--instructions-file prompt-system.txt
--reasoning-summary auto|concise|detailed|none
--tool-choice auto|none|required
--parallel-tools true|false
--timeout <ms>
--retries <0..5>
--retry-delay <ms>
```

Unsupported request flags are rejected instead of silently ignored. For example,
this endpoint currently rejects sampling controls such as `temperature`,
`top_p`, and `max_output_tokens`.

## Commands

```sh
pro setup
pro auth command
pro auth capture
pro auth status
pro doctor
pro models
pro run "prompt"
pro submit "prompt"
pro status <job-id>
pro wait <job-id>
pro result <job-id>
pro cancel <job-id>
pro jobs
pro config get
pro config set model auto
pro config set reasoning low
```

Every command supports `--json`. Non-TTY stdout automatically switches to JSON.
Errors include `code`, `message`, and `suggestions`.

Exit codes:

- `0`: success
- `1`: not found or not ready
- `2`: invalid arguments
- `3`: auth required or expired
- `4`: upstream rejected the request
- `5`: network or interrupted stream
- `6`: timeout
- `7`: internal error

## Safety Model

`pro auth capture` writes sensitive local files:

- scoped ChatGPT/OpenAI cookie JSON
- Netscape cookie jar
- ChatGPT session-token JSON
- SQLite job database
- worker logs

Defaults:

- home: `~/.pro`
- cookies: `~/.pro/cookies/`
- token: `~/.pro/tokens/chatgpt-session.json`
- jobs: `~/.pro/jobs.sqlite`
- worker logs: `~/.pro/workers/`

Files are written with private permissions where the OS supports it: `0600` for
files and `0700` for directories.

Do not commit, paste, or share `~/.pro`. Treat it like SSH keys or browser
session data. `pro` does not print raw cookie or token values in normal status,
doctor, jobs, or list output.

## Troubleshooting

Auth missing or expired:

```sh
pro setup --json
pro auth command
pro auth capture --cdp http://127.0.0.1:9222 --json
```

See available models and reasoning modes:

```sh
pro models --json
```

Check whether the CLI is ready:

```sh
pro doctor --json
```

Inspect recent jobs without dumping full prompts or outputs:

```sh
pro jobs --limit 5 --json
```

Get the full output only when needed:

```sh
pro result <job-id> --json
```

## Design Notes

`pro` uses Chrome DevTools Protocol only to read a user-consented logged-in
ChatGPT page. It captures the page session token and scoped cookies, stores them
locally, and sends requests back to ChatGPT’s web backend.

This project is for legal ChatGPT subscribers using their own subscription. It
does not bypass authentication, subscriptions, rate limits, access controls, or
account restrictions.
