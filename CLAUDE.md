# Notes for agents

READMEs only explain what the plugins are and do (plus the "Built with Claude" line in the root one). Decisions and
working rules belong here; keep them up to date.

| Folder | Plugin | ID | Actions |
|---|---|---|---|
| `api-tools` | API Tools | `io.github.tekinozbek.api-tools` | Webhook (`.call`), API Toggle (`.toggle`) |
| `utilities` | Utilities | `io.github.tekinozbek.utilities` | Simple Clock (`.clock`) |

## Decisions

**Identity and licence**
- IDs must not change once published (it breaks placed keys).
- MIT. The root, per-plugin `LICENSE` and `.sdPlugin/LICENSE.txt` files stay identical.
- Third-party notices live only in the root `THIRD-PARTY-NOTICES.md`. Add anything third-party there; the build
  copies it into each `.sdPlugin` (those copies are ignored by git, don't edit them). Use bullet lists for
  copyright lines: plain consecutive lines run together in Markdown.
- Never commit built or packaged plugins (`bin/`, `*.streamDeckPlugin`) or logs.

**Icons** (white strokes; Iconoir SVGs supplied by the owner; PNGs at 1x and 2x)
- Default key icons: 48 px glyph (longer side) on the 72 px key, stroke 1.25.
- Action list and category icons: glyph fills the image, stroke 1.25.
- Plugin icons: stroke 1.5, padded, on `#3d354b`.
- Sources: `code-brackets` (Webhook), `square` / `check-square` / `help-square` / `warning-square` (toggle),
  `wristwatch` (Simple Clock), `developer` (API Tools), `tools` (Utilities).
- Never edit the PNGs by hand: SVGs are in `icons/src`, and `icons/make_icons.py` renders them all:

      python -m venv icons\.venv
      icons\.venv\Scripts\pip install pymupdf==1.28.2
      icons\.venv\Scripts\python -I icons\make_icons.py

**API Tools**
- Redirects are refused, so headers, bodies and query strings can't leak.
- API Toggle: separate On and Off requests; the key never flips itself, it shows what polling reports.
- Toggle icons: Default, File on disk or Status response only. No picking built-in icons by name.
- Help starts with "Test with a harmless endpoint first".
- API Toggle and Simple Clock are not offered in multi-actions.

**Simple Clock**
- Plain text, no images (the key image is blank).
- Uses Stream Deck's native title so the T menu styles it; our text field is "Prefix". Don't disable the
  title box or draw the text as SVG.

## Working here

- Node 20+ is needed. This machine has no global Node: a portable one sits in `.tools\node` (not committed).
  The manifests target Node 20; the local one is Node 22. In a plugin folder, in PowerShell:

      . .\scripts\env.ps1     # Node from .tools at the repo root, if there
      npm ci                  # api-tools: add --legacy-peer-deps if peer resolution fails
      npm test
      npm run typecheck       # sources and tests
      npm run build
      npx streamdeck validate <id>.sdPlugin
      npx streamdeck link <id>.sdPlugin     # once, to register for development
      npm run pack                          # produce .streamDeckPlugin

- After any plugin change: test, build, validate, then restart the Stream Deck app.
- Don't install into global Python; use a venv. Don't touch files outside this folder unless asked.
- Keep `Nodejs.Debug` out of the manifests (it opens an inspector port).
- `sdpi-components.js` is vendored into each `ui/` folder; nothing loads remote code. `scripts/vendor-sdpi.mjs`
  restores it and only accepts the pinned version.
- Stream Deck doesn't await event handlers. After any await in an action, check the key is still on screen.
- Regexes and loops that see API data must stay linear. Never log TypeError messages: they quote URLs and headers.
- Target is Elgato Marketplace: SDK 2.x, `SDKVersion` 3, Stream Deck 6.9+. For DRM, don't read the manifest
  at runtime or modify shipped files.

## Commits

- Commits and tags are signed with the owner's SSH key (set in this repository's Git config). Never bypass signing.
  After amending a tagged commit, move and re-sign the tag too.

- Every commit an agent creates ends with a co-author trailer, after a blank line:

      Co-Authored-By: Claude <noreply@anthropic.com>

- Write an informative message: a short summary line, then a body saying what changed and why. The initial commit is
  the only exception to the detailed description.
