# pro-cli

<p align="center">
  <img src="assets/readme/pro-cli-hero.jpg" alt="Neon ChatGPT Pro interface globe for pro-cli" width="100%">
</p>

`pro-cli` installs `pro`: a local, agent-friendly CLI for asking your own ChatGPT Pro web account from terminal workflows.

It gives coding agents a scriptable path to the ChatGPT Pro surface you already use in the browser: current Pro models, reasoning levels, Deep Research-style/tool-backed capabilities when available to your account, and JSON-first job control.

`pro` is built for legal ChatGPT subscribers using their own session. It does not bypass authentication, subscriptions, rate limits, access controls, or account restrictions.

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

The installer clones or fast-forwards `~/Projects/pro-cli`, runs `bun install`, runs `bun link`, and prints `pro --version`. It does not touch auth, cookies, Chrome, or `~/.pro`.

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

Keep the dedicated Chrome window open while using `pro run`, `pro submit`, or `pro wait`. The normal ChatGPT frontend request is executed inside that logged-in browser context.

Port `9222` is the default. If that port is already in use, run `pro auth command --port 9223 --json`, keep using the returned `--cdp http://127.0.0.1:9223` value, and pass the same `--cdp` or `--port` to `pro doctor`, `pro run`, and `pro submit`. `pro wait` uses the CDP value stored on the submitted job.

## Runtime Model

`pro` is not a standalone ChatGPT daemon. It is a CLI that drives a real ChatGPT browser session through Chrome DevTools Protocol.

That means one Chrome instance must be running with `--remote-debugging-port`, and that Chrome instance must have an open, logged-in `https://chatgpt.com/` tab while `pro run`, `pro submit`, `pro wait`, or a background worker is executing a job. `pro` sends the request from inside that page so it can use the same browser cookies, page session, frontend headers, and streaming/resume behavior as the ChatGPT web app.

The recommended steady-state setup is:

```sh
pro auth command --json
# Run the returned Chrome command, sign in, and leave that window open.
pro auth capture --cdp http://127.0.0.1:9222 --json
pro doctor --cdp http://127.0.0.1:9222 --json
```

Use the dedicated `~/.pro/chrome-profile` window returned by `pro auth command` for normal operation. Attaching CDP to a normal personal Chrome profile can work, but it gives the local agent access to that browser profile while the debugging port is open. The dedicated profile keeps the blast radius scoped to ChatGPT.

Operationally, treat the dedicated Chrome window like a small local service: start it once, leave it open, and have agents run `pro doctor --json` before relying on it. If Chrome was closed, run `pro auth command --json` again. If ChatGPT logged out, sign in in that window and run `pro auth capture --cdp <url> --json` again.

## Agents File

Put this in the highest shared agent instructions file you control, such as a user-level `AGENTS.md` or `CLAUDE.md`, so agents in any project can use it:

```md
Use `pro` to ask my ChatGPT Pro web account for hard questions, extended thinking, Deep Research, or current model/tool capabilities. Prefer JSON and async jobs: `pro submit @prompt.md --reasoning high --json`, then `pro wait <job-id> --json` and `pro result <job-id> --json`. `pro` requires the dedicated ChatGPT Chrome/CDP window to stay open; run `pro doctor --json` first if unsure. If auth or the live browser is missing, run `pro setup --json` and follow the returned commands. Never print, paste, or commit `~/.pro`.
```

## Daily Use

`pro` is designed for your agent to operate. These are the commands an agent should run while working inside any repo. Agents should use `--json`; non-TTY stdout switches to JSON automatically.

`run` and `submit` default to `http://127.0.0.1:9222` for the active ChatGPT browser context. Pass `--cdp` or `--port` if the Chrome command used a different port. `wait` uses the CDP value stored on the submitted job.

Setup and auth:

```sh
pro setup --json
pro auth command --json
# Run the returned Chrome command, sign in, and leave that window open.
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

New `run` and `submit` requests default to temporary ChatGPT conversations. Use `--save` when the turn should be written to ChatGPT history. Continuing with `--conversation` defaults to saved mode; pass both ids from the ChatGPT conversation:

```sh
pro run "follow up" --save --conversation <conversation-id> --parent <message-id> --json
```

When `--model auto` is paired with a thinking mode, `pro` selects the current Thinking model and maps aliases onto the web app's effort values: `low=min`, `medium=standard`, `high=max`, and `extended=extended`. For an explicit model id, use an effort shown by `pro models --json` for that model.

Request controls:

```sh
--model auto|<id from pro models>
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

`pro` uses a browser session you control. The recommended setup opens a dedicated Chrome profile for ChatGPT, captures scoped ChatGPT/OpenAI cookies plus the page session token, and stores them locally under `~/.pro`.

Treat `~/.pro` like SSH keys or browser session data. Do not commit it, paste it, sync it to other machines, or share it with other users.

Normal setup, doctor, job, and status output redacts raw cookies and tokens. Files are written with private permissions where the OS supports them: `0600` for files and `0700` for directories. Requests go to `https://chatgpt.com`.
