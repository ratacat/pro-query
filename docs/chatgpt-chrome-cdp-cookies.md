# ChatGPT Chrome CDP Cookie Export

Use this flow when the user consents to using their local Chrome login for ChatGPT research or CLI development.

## What Worked

1. Open `https://chatgpt.com/` in the real Chrome app and confirm the logged-in UI is visible.
2. Check whether the running Chrome already exposes CDP on `127.0.0.1:9222`.
3. If no CDP port exists, copy only the needed Chrome profile files into a private temp profile:
   - `Local State`
   - `Default/Cookies`
   - `Default/Preferences`
4. Launch a separate Chrome instance with the copied profile and CDP enabled:

```bash
open -na "Google Chrome" --args \
  --user-data-dir=/private/tmp/pro-query-chrome-profile \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  https://chatgpt.com
```

5. Attach to the browser with `agent-browser --cdp 9222`.
6. Verify login through the accessibility snapshot. The successful check showed the account UI, recent chats, prompt textbox, and `Extended Pro` model control.
7. Export cookies through direct CDP, scoped to ChatGPT/OpenAI URLs:
   - `https://chatgpt.com/`
   - `https://auth.openai.com/`
   - `https://openai.com/`
   - `https://sentinel.openai.com/`
   - `https://ws.chatgpt.com/`
8. Write the result as `0600` JSON and Netscape cookie jars. Do not print raw cookie values.
9. Close the temporary Chrome instance and delete the copied profile.

## Notes

- Chrome stores these cookies encrypted. Reading the SQLite rows is enough to list names and metadata, but not values.
- The Keychain item `Chrome Safe Storage` existed, but `security find-generic-password -w ...` could not read the secret from the shell session.
- Letting Chrome decrypt its own copied cookie DB through CDP worked.
- `agent-browser cookies get` is too broad for this task because it can dump unrelated browser cookies. Use direct CDP `Network.getCookies` with scoped URLs instead.
- A standalone `curl` call to `https://chatgpt.com/api/auth/session` with the cookie jar returned Cloudflare `403`; that did not invalidate the cookies. The useful validation came from the logged-in Chrome/CDP page state.

## Cleanup Checklist

- Remove the copied Chrome profile under `/private/tmp/pro-query-chrome-profile`.
- Remove any overbroad cookie dumps.
- Keep scoped cookie jars private with mode `0600`.
- Never commit cookie jars or raw session values.
