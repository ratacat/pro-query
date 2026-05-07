# pro-query

`pro` is a Bun/TypeScript CLI for AI agents that need to submit work through a
user-consented, logged-in ChatGPT Pro browser session.

The CLI is robot-first:

- every command supports `--json`
- non-TTY output defaults to JSON
- errors are structured with `code`, `message`, and `suggestions`
- jobs are durable and async by default
- prompts and cookie/token values are not printed in status/list output

## Install

```sh
bun install
```

## Auth Capture

Open Chrome with CDP and a logged-in ChatGPT tab, then capture scoped session
state:

```sh
pro auth capture --cdp http://127.0.0.1:9222 --json
pro auth status --json
```

`auth capture` stores:

- scoped ChatGPT/OpenAI cookies
- a Netscape cookie jar
- a private ChatGPT session-token JSON file

These files live outside the repo by default under `~/.pro` or paths configured
through `.env.local`.

## Submit Jobs

```sh
pro submit "Reply with OK only." --model gpt-5.4 --reasoning low --json
pro wait <job-id> --json
pro result <job-id> --json
```

`jobs` and `status` return compact previews. Use `result` to retrieve the full
model output.

## Commands

```sh
pro auth status|capture
pro models
pro submit "prompt"
pro status <job-id>
pro wait <job-id>
pro result <job-id>
pro cancel <job-id>
pro jobs
pro doctor
```

## Safety

This project is for local use by legal ChatGPT subscribers using their own
browser session. It does not bypass authentication, subscriptions, rate limits,
access controls, or account restrictions.
