# pro-cli

`pro-cli` installs `pro`: a local, agent-friendly CLI for asking your own ChatGPT Pro web account from terminal workflows.

It gives coding agents a scriptable path to the ChatGPT Pro surface you already use in the browser: current Pro models, reasoning levels, Deep Research-style/tool-backed capabilities when available to your account, and JSON-first job control.

`pro` is built for legal ChatGPT subscribers using their own session. It does not bypass authentication, subscriptions, rate limits, access controls, or account restrictions.

## Install

Requires Bun. `pro-cli` has been tested on macOS. Windows may work, but the install and Chrome auth commands may need adjustment.

Run this from the directory where you want the `pro-cli` checkout to live:

```sh
if [ -d pro-cli/.git ]; then git -C pro-cli pull --ff-only; else git clone https://github.com/ratacat/pro-cli.git; fi && cd pro-cli && bun install && bun link
```

Rerun the same command to fast-forward an existing clone before relinking.

## Auth Paths

`pro` needs a logged-in ChatGPT Pro browser session before agents can use it. Choose one of these paths.

**Option A: Quick Auth**

Use this if you are already logged in to ChatGPT in Chrome and you trust the current agent with temporary access to your local browser profile. Copy this into your AI agent:

```txt
I am logged in to ChatGPT in Chrome. Set up pro-cli auth from my existing Chrome profile. Store only scoped ChatGPT/OpenAI auth under ~/.pro, do not print raw cookies or tokens, then verify with pro doctor --json.
```

**Option B: Manual Auth**

Use this if you do not want an agent touching your normal browser profile. It uses a dedicated Chrome profile for `pro`. Copy these commands into your terminal:

```sh
pro auth command --json
```

Run the returned Chrome command yourself, sign in to ChatGPT in that window, then capture auth from that dedicated profile:

```sh
pro auth capture --cdp http://127.0.0.1:9222 --json
pro doctor --json
```

## Agents File

Put this in the highest shared agent instructions file you control, such as a user-level `AGENTS.md` or `CLAUDE.md`, so agents in any project can use it:

```md
Use `pro` to ask my ChatGPT Pro web account for hard questions, extended thinking, Deep Research, or current model/tool capabilities. Prefer JSON and async jobs: `pro submit @prompt.md --reasoning high --json`, then `pro wait <job-id> --json` and `pro result <job-id> --json`. If auth is missing, run `pro setup --json` and follow the returned commands. Never print, paste, or commit `~/.pro`.
```

## Daily Use

`pro` is designed for your agent to operate. These are the commands an agent should run while working inside any repo. Agents should use `--json`; non-TTY stdout switches to JSON automatically.

Setup and auth:

```sh
pro setup --json
pro auth command --json
pro auth capture --cdp http://127.0.0.1:9222 --json
pro doctor --json
```

Models and capabilities:

```sh
pro models --json
pro config get --json
pro config set model auto --json
pro config set reasoning high --json
```

Async work:

```sh
pro submit @prompt.md --model auto --reasoning high --json
pro wait <job-id> --wait-timeout 60000 --json
pro result <job-id> --json
pro cancel <job-id> --json
pro jobs --limit 20 --json
```

Direct work, when the caller wants to block:

```sh
pro run @prompt.md --model auto --reasoning high --json
```

Request controls:

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

Unsupported request flags fail loudly instead of being ignored. Errors include `code`, `message`, and `suggestions`.

## Safety

`pro` uses a browser session you control. The recommended setup opens a dedicated Chrome profile for ChatGPT, captures scoped ChatGPT/OpenAI cookies plus the page session token, and stores them locally under `~/.pro`.

Treat `~/.pro` like SSH keys or browser session data. Do not commit it, paste it, sync it to other machines, or share it with other users.

Normal setup, doctor, job, and status output redacts raw cookies and tokens. Files are written with private permissions where the OS supports them: `0600` for files and `0700` for directories. Requests go to `https://chatgpt.com`.
