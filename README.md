# pro-cli

<p align="center">
  <img src="assets/readme/pro-cli-hero.jpg" alt="Neon ChatGPT Pro interface globe for pro-cli" width="100%">
</p>

Agent native CLI for querying ChatGPT Pro and Deep Research through your own logged-in web session, managed from your terminal.

It gives coding agents a scriptable path to the ChatGPT Pro surface you already use in the browser: current Pro models, reasoning levels, Deep Research-style/tool-backed capabilities when available to your account, and JSON-first job control.

`pro-cli` is built for legal ChatGPT subscribers using their own session. It does not bypass authentication, subscriptions, rate limits, access controls, or account restrictions.

## Install

Requires Bun. `pro-cli` has been tested on macOS. Windows may work, but the install and Chrome auth commands may need adjustment.

Quick install:

```sh
curl -fsSL https://raw.githubusercontent.com/ratacat/pro-cli/main/scripts/install.sh | bash
```

To choose the checkout path:

```sh
curl -fsSL https://raw.githubusercontent.com/ratacat/pro-cli/main/scripts/install.sh | PRO_INSTALL_DIR="$HOME/Projects/pro-cli" bash
```

The installer clones or fast-forwards `~/Projects/pro-cli`, runs `bun install`, runs `bun link`, and prints `pro-cli --version`. It does not touch auth, cookies, Chrome, or `~/.pro`.

## Auth Paths

`pro-cli` needs a logged-in ChatGPT Pro browser session before agents can use it. Choose one of these paths.

**Option A: Quick Auth**

Use this if you are already logged in to ChatGPT in Chrome and you trust the current agent with temporary access to your local browser profile. Copy this into your AI agent:

```txt
I am logged in to ChatGPT in Chrome. Set up pro-cli auth from my existing Chrome profile. Store only scoped ChatGPT/OpenAI auth under ~/.pro, do not print raw cookies or tokens, then verify with pro-cli doctor --json.
```

**Option B: Manual Auth**

Use this if you do not want an agent touching your normal browser profile. It uses a dedicated Chrome profile for `pro-cli`. Copy these commands into your terminal:

```sh
pro-cli auth command --json
```

Run the returned Chrome command yourself, sign in to ChatGPT in that window, then capture auth from that dedicated profile:

```sh
pro-cli auth capture --cdp http://127.0.0.1:9222 --json
pro-cli doctor --json
```

Leave the dedicated Chrome window open while using `pro-cli`.

Port `9222` is the default. If that port is already in use, run `pro-cli auth command --port 9223 --json`, keep using the returned `--cdp http://127.0.0.1:9223` value, and pass the same `--cdp` or `--port` to `pro-cli doctor`, `pro-cli run`, and `pro-cli submit`. `pro-cli wait` uses the CDP value stored on the submitted job.

## Keep Chrome Running

What you need to do:

- Start the Chrome command from `pro-cli auth command --json`.
- Sign in to ChatGPT in that window.
- Leave that window open while `pro-cli` jobs run.
- Run `pro-cli doctor --json` when you are not sure whether it is ready.

What is happening: `pro-cli` submits requests from inside that logged-in ChatGPT tab over Chrome DevTools Protocol. That gives it the same browser cookies, page session, frontend headers, and streaming/resume behavior as the ChatGPT web app.

The normal setup is:

```sh
pro-cli auth command --json
# Run the returned Chrome command, sign in, and leave that window open.
pro-cli auth capture --cdp http://127.0.0.1:9222 --json
pro-cli doctor --cdp http://127.0.0.1:9222 --json
```

Use the dedicated `~/.pro/chrome-profile` window for normal operation. A normal personal Chrome profile can work, but the debugging port exposes that profile while it is open. The dedicated profile keeps the scope limited to ChatGPT.

If Chrome was closed, run `pro-cli auth command --json` again. If ChatGPT logged out, sign in in that window and rerun `pro-cli auth capture --cdp <url> --json`.

## Agents File

Put this in the highest shared agent instructions file you control, such as a user-level `AGENTS.md` or `CLAUDE.md`, so agents in any project can use it:

```md
Use `pro-cli` to ask my ChatGPT Pro web account for hard questions, extended thinking, Deep Research, or current model/tool capabilities. Prefer JSON and async jobs: `pro-cli submit @prompt.md --reasoning high --json`, then `pro-cli wait <job-id> --json` and `pro-cli result <job-id> --json`. `pro-cli` requires the dedicated ChatGPT Chrome/CDP window to stay open; run `pro-cli doctor --json` first if unsure. If auth or the live browser is missing, run `pro-cli setup --json` and follow the returned commands. Never print, paste, or commit `~/.pro`.
```

## Daily Use

`pro-cli` is designed for your agent to operate. These are the commands an agent should run while working inside any repo. Agents should use `--json`; non-TTY stdout switches to JSON automatically.

`run` and `submit` default to `http://127.0.0.1:9222` for the active ChatGPT browser context. Pass `--cdp` or `--port` if the Chrome command used a different port. `wait` uses the CDP value stored on the submitted job.

Setup and auth:

```sh
pro-cli setup --json
pro-cli auth command --json
# Run the returned Chrome command, sign in, and leave that window open.
pro-cli auth capture --cdp http://127.0.0.1:9222 --json
pro-cli doctor --json
```

Models and capabilities:

```sh
pro-cli models --json
pro-cli config get --json
pro-cli config set model auto --json
pro-cli config set reasoning high --json
```

Async work:

```sh
pro-cli submit @prompt.md --model auto --reasoning high --json
pro-cli wait <job-id> --wait-timeout 60000 --json
pro-cli result <job-id> --json
pro-cli cancel <job-id> --json
pro-cli jobs --limit 20 --json
```

Direct work, when the caller wants to block:

```sh
pro-cli run @prompt.md --model auto --reasoning high --json
```

New `run` and `submit` requests default to temporary ChatGPT conversations. Use `--save` when the turn should be written to ChatGPT history. Continuing with `--conversation` defaults to saved mode; pass both ids from the ChatGPT conversation:

```sh
pro-cli run "follow up" --save --conversation <conversation-id> --parent <message-id> --json
```

When `--model auto` is paired with a thinking mode, `pro-cli` selects the current Thinking model and maps aliases onto the web app's effort values: `low=min`, `medium=standard`, `high=max`, and `extended=extended`. For an explicit model id, use an effort shown by `pro-cli models --json` for that model.

Request controls:

```sh
--model auto|<id from pro-cli models>
--reasoning auto|low|medium|high|extended|min|standard|max
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
```

Unsupported request flags fail loudly instead of being ignored. Errors include `code`, `message`, and `suggestions`.

## Safety

`pro-cli` uses a browser session you control. The recommended setup opens a dedicated Chrome profile for ChatGPT, captures scoped ChatGPT/OpenAI cookies plus the page session token, and stores them locally under `~/.pro`.

Treat `~/.pro` like SSH keys or browser session data. Do not commit it, paste it, sync it to other machines, or share it with other users.

Normal setup, doctor, job, and status output redacts raw cookies and tokens. Files are written with private permissions where the OS supports them: `0600` for files and `0700` for directories. Requests go to `https://chatgpt.com`.
