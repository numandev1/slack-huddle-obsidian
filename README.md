# slack-huddle-obsidian

Saves a transcript of every **Slack huddle** to your **Obsidian** vault. When the huddle ends, it saves a **ChatGPT summary** too and shows a macOS notification.

It's the Slack companion to [MeetingTranscriptToObsidian](https://github.com/numandev1/MeetingTranscriptToObsidian), which does the same for Google Meet, Teams and Zoom in Chrome. The note format and the summary prompt are the same.

- **No app to install.** It's a small Node script that runs in the background.
- **No bot, no Slack admin, no API keys.** It reads the captions Slack already shows you.
- **Private.** Notes go straight into your vault. The only thing sent anywhere is the transcript, to *your own* ChatGPT session in Chrome, for the summary (and you can turn that off).

## Install

You need macOS, the Slack desktop app, Obsidian, and [Node.js 22+](https://nodejs.org).

```bash
npx github:numandev1/slack-huddle-obsidian setup
```

Setup asks which vault to use, restarts Slack once, and checks that everything works.

Then do two things by hand:

1. **In Slack → Settings → Advanced, turn off "Launch Slack on login".** This tool opens Slack at login itself, with the setting it needs.
2. **For summaries:** in Chrome, open `chrome://inspect/#remote-debugging`, tick **Allow remote debugging for this browser instance**, and make sure you're signed in to [chatgpt.com](https://chatgpt.com). If you don't want summaries, run setup with `--no-summary`.

## Use

Join huddles as usual. Captions turn on by themselves. When you leave:

- `Meetings/Slack - <workspace>/2026-10-28 1639 Huddle - Jane Doe.md` holds the transcript, grouped by speaker with timestamps.
- `MeetingSummary/Slack - <workspace>/…` holds the summary, key points, decisions and action items, linked to the transcript.
- You get a notification: **Meeting summary saved**.

The transcript note is saved while the huddle is still running, so a crash doesn't lose it.

> **If you quit Slack, don't reopen it from the Dock.** Slack would open without the setting this tool needs. Use:
> ```bash
> npx github:numandev1/slack-huddle-obsidian restart-slack
> ```
> Restarting your Mac also works.

## Commands

```bash
npx github:numandev1/slack-huddle-obsidian setup          # install or update
npx github:numandev1/slack-huddle-obsidian doctor         # check that everything works
npx github:numandev1/slack-huddle-obsidian restart-slack  # reopen Slack the right way
npx github:numandev1/slack-huddle-obsidian logs           # follow the log
npx github:numandev1/slack-huddle-obsidian uninstall      # remove (--purge also deletes settings)
```

Setup options: `--vault <path>`, `--no-summary`, `--port <n>` (default 9333), `--meetings-folder <name>`, `--summary-folder <name>`, `--chrome <user-data-dir>`, `-y`.

Settings live in `~/.slack-huddle-obsidian/config.json`. After editing it, rerun `setup -y`.

## How it works

- Slack's desktop app is built on Chromium. Started with `--remote-debugging-port`, it lets a local program read its windows, the same way Chrome DevTools does. The port only listens on `127.0.0.1`.
- A background script (a LaunchAgent) watches for a huddle, turns on **Show captions → Side-by-side**, and copies each caption line and its speaker into the note.
- When the huddle ends, it opens a small ChatGPT window in your Chrome, sends the transcript with the summary prompt, saves the answer and closes the window.

## Limits

- **macOS only.**
- **Caption quality is Slack's.** Set the huddle language in Slack to match the language spoken. If two people share a room without headphones, lines may come out duplicated.
- **Slack updates can break it** if they rename the caption elements. It's tested on Slack 4.52, and `doctor` warns when your version is different. Please open an issue if notes stop appearing.
- **Tell people you're keeping notes.** Everyone in the huddle sees captions are on, but saving them is your responsibility.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No notes at all | Run `doctor`. Usually Slack was opened from the Dock, so run `restart-slack`. |
| Transcript saved, summary failed | The notification says why. Usually Chrome is closed, remote debugging is off, or you're signed out of ChatGPT. |
| "No captions were captured" | Captions couldn't be turned on. Turn them on by hand: huddle **⋯ → Show captions → Side-by-side**. |

## License

MIT
