## Project

`pro-query` is a Bun/TypeScript CLI for querying ChatGPT Pro through the user's existing authenticated browser session.

The goal is to let terminal tools ask ChatGPT Pro without requiring the user to manually paste context into the web UI and wait for a response.

## Constraints

- Build the project in Bun and TypeScript.
- Use the user's existing browser login cookies/session only with their consent.
- Treat this as a utility for legal ChatGPT subscribers using their own subscription.
- Do not bypass authentication, subscriptions, rate limits, access controls, or account restrictions.
- Do not build credential theft, session exfiltration, account sharing, or unauthorized access flows.

## Research First

Before implementation, research how the ChatGPT web app talks to its backend API.

Document:
- Browser endpoints and request shapes used by the web app
- Required headers, cookies, CSRF/session tokens, and streaming formats
- Model and reasoning-level options exposed by the web UI
- Conversation creation, message submission, polling/streaming, cancellation, and retry behavior
- Failure modes such as expired sessions, throttling, network interruption, and partially streamed responses

Prefer reproducible local observations from the authenticated browser session. Keep findings minimal and link to larger notes when needed.

When probing ChatGPT with test queries, use temporary conversations by default. Only create, save, or continue non-temporary conversations when the behavior under test specifically requires saved history, continuation, or sidebar-visible conversation state.

See `docs/chatgpt-chrome-cdp-cookies.md` for the validated local Chrome/CDP cookie export flow.
See `docs/chatgpt-431-cookie-bloat.md` when ChatGPT returns `431` or the CDP page resolves to `chrome-error://chromewebdata/`.

## CLI Requirements

- Async by default: submit work, return a job id, and allow later status/result collection.
- Resilient execution: support retries, reconnects, cancellation, timeout control, and recovery from interrupted streams.
- Configurable thinking levels and any other model/runtime options exposed by the web app.
- Clear session handling: detect expired auth and ask the user to refresh their browser login.
- Safe local storage: never print or persist raw cookies unless explicitly requested for debugging.
- Local cookie paths may live in ignored `.env.local` as `CHATGPT_COOKIE_JAR` and `CHATGPT_COOKIE_JSON`; the cookie files stay outside the repo.
- Script-friendly output: provide JSON output modes for other terminal CLIs.
