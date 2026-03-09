# Email QA Viewer

A lightweight local app for reviewing HTML marketing emails before they are pasted into HubSpot or another sending platform.

## What it does

- Previews HTML emails at common mobile, tablet, email, and desktop widths
- Watches a folder of `.html` files and auto-refreshes when they change
- Supports nested campaign folders inside the watch directory
- Lets non-technical users paste raw HTML directly into the app for a quick review
- Runs a built-in checklist for common email issues:
  - missing doctype
  - missing viewport meta
  - missing `lang`
  - large HTML size that may trigger Gmail clipping
  - missing image alt text
  - HTTP links
  - relative links
  - placeholder or unsafe links
  - missing unsubscribe language
- Validates live HTTP and HTTPS links from the server
- Copies final HTML to the clipboard or downloads a timestamped `.html` file

## Default workflow

1. Put email files in the local `emails/` folder, or point the app at a different folder with `WATCH_DIR`.
2. Run `npm install` once.
3. Run `npm start`.
4. Open `http://localhost:3756`.
5. Select a file or paste HTML.
6. Check width behavior, review the checklist, validate links, then copy the HTML into HubSpot.

## Setup

```bash
npm install
npm start
```

By default the app watches:

```text
./emails
```

To use another folder:

```bash
WATCH_DIR="/path/to/email-folder" npm start
```

To use another port:

```bash
PORT=4000 npm start
```

## Recommended rollout setup

For a marketing team rollout:

1. Keep the app in a shared local repo or internal tooling repo.
2. Point `WATCH_DIR` at the team’s shared email working folder.
3. Standardize a folder structure such as `campaign-name/email-name.html` so files stay organized.
4. Ask the team to use the app for three gates before send:
   - width review
   - checklist review
   - link validation
5. Treat this as preflight QA, not a replacement for inbox rendering tests in Litmus or Email on Acid.

## Notes

- Link validation requires server network access.
- Relative image and asset paths now work in preview mode when the assets live under the watched folder.
- The checklist is intentionally practical, not exhaustive. It catches common production misses quickly.

## Project files

- `server.js`: HTTP server, watched-folder preview routing, checklist API, link validation API, WebSocket refresh
- `public/index.html`: UI, preview controls, pasted HTML flow, checklist and link results
- `.gitattributes`: keeps source files on LF to reduce noisy diffs
