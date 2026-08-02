# YouTube Comment Timestamp Chapters

A Chrome extension that finds timestamps mentioned in YouTube comments (like
`4:48 "That's usefull, actually!"`) and marks them on the video's progress bar — like
chapters, but crowdsourced from the comments section.

Not published on the Chrome Web Store — load it manually, it takes under a
minute.

## Features

- **Progress bar markers** — every timestamp mentioned in the comments gets
  a tick mark on the scrubber. Mentioned by multiple commenters? It turns
  gold.
- **Hover tooltip** — hover a marker to see the timestamp and a preview of
  the comment that mentioned it.
- **"Coming up" toast** — a heads-up a few seconds before playback reaches a
  marker. Lead time grows automatically for longer comments so you have time
  to read. Hover it to pause and read at your own pace; click the × to
  dismiss it.
- **Optional chime** — plays when a marker is coming up, with its own volume
  slider (0–150%) and support for uploading your own short sound clip.
- **Fully configurable** — every feature above can be toggled off
  independently, and the toast's on-screen position (6 placements) is
  configurable, all from the toolbar popup.

## Install (manual — no Chrome Web Store)

1. Download this repository: click the green **Code** button above →
   **Download ZIP**, then unzip it. (Or `git clone` it if you're familiar
   with git.)
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the unzipped folder (the one containing `manifest.json`).

That's it — open any YouTube video with timestamped comments and scroll to
the comments section to see it work.

## Updating

Chrome doesn't auto-update manually-loaded extensions. To update: pull the
latest changes (or re-download the ZIP), then click the reload icon on the
extension's card at `chrome://extensions`.

## Privacy

This extension doesn't collect, transmit, or sell any data. It only reads
the YouTube page you're already viewing to find timestamps in comments.
Every setting (including any custom sound clip you upload) is stored
locally in your own browser via `chrome.storage.local` and never leaves
your machine. There is no backend and no analytics.

## License

MIT
