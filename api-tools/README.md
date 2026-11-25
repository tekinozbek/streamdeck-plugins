# API Tools

A Stream Deck plugin with keys that talk to your own HTTP APIs (Stream Deck 6.9+).

- **Webhook**: call a URL on press or on a timer, and show the answer on the key as text or an image, or open a URL
  built from it.
- **API Toggle**: an on/off key whose state comes from your API. A press calls your On or Off request.

Each press and each poll sends a real request, so test with a harmless endpoint first.

## Webhook action

### Behaviour

- A body that is valid JSON is sent as `application/json` unless you set your own `Content-Type` header.
- Polling works for GET and HEAD only. Other methods only run on key press.
- Responses over 1 MiB are rejected.
- **Timeout** is 1-120 seconds. Empty or `0` means 10 s; values above 120 are treated as 120.
- Redirects (301/302/303/307/308 with a `Location` header) are never followed. Following one would re-send the request
  somewhere you did not configure and could leak headers, the body or the query string. The key shows `REDIRECT` and the
  log says which status came back (never the target). Point the URL straight at the final address.
- Logs: a message that repeats for the same key (for example a poll failing every 250 ms) is written once, followed by a
  "repeated N times" line when it changes or recovers. Network failures are one line, no stack trace. URLs are logged
  without query string, and headers and bodies are never logged. The plugin keeps its `logs/` folder to about 5 MB.
- While polling, a request waits at most the longer of 3 s and 3x the poll interval (never more than your Timeout), so a hung API is retried quickly. Key presses use the full Timeout and are not retried automatically; press again to retry.
- With "Open URL" the key shows no checkmark; the browser opening is the feedback. A failure still flashes the alert.
- URL, headers and body are stored as plain text in the Stream Deck profile and included when you export or share it. Remove tokens first.

### Expression field

| Input | Result |
|---|---|
| `data.items[0].count` | plain path |
| `{cpu.name}: {cpu.temp}` | joined values |
| `={a} + {b}` | maths (`+ - * / %`, parentheses); functions go outside the braces: `=round({a}, 2)` |
| `{time.hour}:{pad({time.minute}, 2)}` | functions inside `{}` |
| `{name}[0:5]`, `{name}[:-1]`, `{name}[-1]` | Python-style slice / index |

Functions: `round(x, digits)`, `fixed(x, digits=1)` (always shows the decimals, e.g. `5` -> `5.0`), `floor`, `ceil`, `abs`, `min`, `max`, `pad(x, width, char)`.
`\n` in the Expression, Prefix and Suffix fields makes a new line (e.g. `{cpu.name}\n{cpu.temp}°C`).

### Icon (from JSON)

The **Icon** field takes an expression (same syntax as above) that must return an image from the response JSON:

- **SVG**: raw markup, or a `data:image/svg+xml` URI (base64 or percent-encoded). Limit 256 KB. `<script>`,
  `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, animation elements, DTD entities and `<use>` references that loop or
  multiply into more than 20,000 elements reject the SVG;
  event-handler attributes, `href`s other than `#id` or an embedded PNG/JPEG/GIF/WebP data URI, and CSS
  `url()` / `@import` are stripped. Attribute values and `<style>` text are also checked after decoding XML entities
  (`&#117;rl(`) and CSS escapes (`\75 rl(`, `@\69mport`); an SVG that hides a fetching `url()`, `@import`, `image-set()`
  or `javascript:` that way is rejected. This is a defensive filter, not a full sanitizer, so only point the plugin at
  APIs you trust. Give the SVG a `viewBox`.
- **PNG** (also JPEG, GIF, WebP): a `data:image/png;base64,…` URI or bare base64. Limit 512 KB. The type is taken from
  the file's own header, not the claimed MIME type, and files that don't look like images are rejected.
- Empty / missing value restores the default icon. An unusable image shows a red `BAD ICON` tile.
- Unchanged icons are not re-sent, so polling won't spam the Stream Deck app.

### Button press

- **Refresh (call the API)**: the default. Pressing the key makes the request and updates the key.
- **Open URL in browser**: opens the URL template in your default browser. Only `http` / `https` are opened.
  `https://example.com/?tz={tz}` fills `{tz}` from the API response (percent-encoded). `{!url}` inserts a value
  as-is, for when the API returns a full URL. Functions and slices work inside `{}`. A missing value cancels the
  open. While polling, the latest response is used; otherwise the API is called first with the Request settings.
  A URL with no `{}` opens immediately. A value that is missing anywhere in the template, including inside a function
  such as `{pad({missing}, 2)}`, cancels the open (the key flashes the alert); the Expression field still shows `n/a`.

### Errors on the key

| Shown | Meaning |
|---|---|
| `HTTP 404` | the API answered with that status |
| `TIMEOUT` / `NO CONN` | no answer in time / could not connect |
| `REDIRECT` | the API answered with a redirect; redirects are not followed |
| `BAD JSON` | response is not JSON (needed by the expression, icon or URL) |
| `TOO BIG` | response over 1 MiB |
| `ERR` | the expression failed |

With an Icon set, the error replaces the icon with a red tile; otherwise it is the key title. It clears on the next
successful call. Keys with nothing to display (no polling, expression or icon) just flash the alert.

## API Toggle action

A two-state key whose on/off state comes from an API, not from presses.

- **Status**: a GET to the Status URL every *Every (ms)* (min 250, default 1000). The **Expression** reads a value from
  the JSON (empty = the whole response text). It is *on* for `true`/`on`/`1`/`yes` (any case); if **On when equals** is
  set, only that value is on and the defaults no longer apply. No value at all shows `NO VALUE`.
- **Press**: while off, the key calls the On request; while on, the Off request (each has its own URL, method, headers
  and body). The key never flips by itself: after the call it polls straight away and shows what the API reports.
  Polling pauses during a press and extra presses are ignored until it finishes.
- **Custom icons** (optional): each state can take its image from a **file on disk** (full local path to an
  svg/png/jpg/gif/webp; network paths are refused) or from an **expression on the status response** (SVG markup or a data
  URI, like the Webhook Icon field). Same filtering and size limits as Webhook icons. A missing file or unusable image
  falls back to the default icon and is logged once. The question-mark and warning icons can't be changed.
- **Display**: square = off, check = on, question mark = not known yet, warning = the last poll failed (the reason is the
  title: `HTTP 500`, `TIMEOUT`, `NO CONN`, `REDIRECT`, `BAD JSON`, `TOO BIG`, `ERR`, `NO VALUE`). After a failure the
  key remembers the last known state, so a press still works; a press before the state was ever known only alerts.
- Same safety rules as Webhook: redirects refused, 1 MiB response cap, deduplicated logs, 1-120 s timeout.
