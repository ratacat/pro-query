# ChatGPT 431 Cookie Bloat

Symptom: the pro-cli Chrome tab shows `chatgpt.com`, but CDP `location.href` is `chrome-error://chromewebdata/`; Chrome network events show `https://chatgpt.com/` returning HTTP `431`.

Cause seen 2026-05-09: 63 `conv_key_*` cookies pushed the ChatGPT request header over Cloudflare's limit. Deleting only `conv_key_*` cookies from the dedicated `~/.pro-cli/chrome-profile` restored the page, `limits`, and `gpt-5-5-pro` requests.

Cookie model: `ask` uses `fetch(..., credentials: "include")` inside the live CDP page, so Chrome's profile cookies are authoritative. Saved JSON/JAR cookies are capture artifacts and diagnostics unless an external tool replays them.

Rough fix: on a `431` auth/session/page response, automatically delete volatile ChatGPT cookies such as `conv_key_*`, reload `https://chatgpt.com/`, then retry once before asking the user to reset the profile.
