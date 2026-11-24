# slack-huddle-obsidian

**Every Slack huddle, saved to Obsidian.** A transcript while you talk, a ChatGPT summary when you hang up.

- **Nothing to install** — a small Node script that runs in the background on your Mac.
- **No bot, no Slack admin, no API keys** — it reads the captions Slack already shows you.
- **Private** — notes go straight into your vault. Only the transcript leaves your Mac, to *your own* ChatGPT in Chrome, for the summary. You can turn that off.

It's the Slack companion to [MeetingTranscriptToObsidian](https://github.com/numandev1/MeetingTranscriptToObsidian) (Google Meet, Teams and Zoom). Same note format, same summary prompt.

> [!IMPORTANT]
> **If you quit Slack, don't reopen it from the Dock.** Use `npx github:numandev1/slack-huddle-obsidian restart-slack`, or restart your Mac. From the Dock, Slack opens without the setting this tool needs and nothing is recorded.

---

## Quick start

**You need:** macOS · the Slack desktop app · Obsidian · [Node.js 22+](https://nodejs.org) · Chrome signed in to [chatgpt.com](https://chatgpt.com) (for summaries)

### 1. Run setup

```bash
npx github:numandev1/slack-huddle-obsidian setup
```

It asks which vault to use, restarts Slack once, and checks that everything works. You stay signed in to Slack.

### 2. Stop Slack opening by itself at login

This tool opens Slack at login with the setting it needs. If Slack opens itself first, nothing gets recorded.

- Right-click Slack in the Dock → **Options** → untick **Open at Login**
- Remove Slack from **System Settings → General → Login Items** if it's there

### 3. Allow summaries in Chrome

Open `chrome://inspect/#remote-debugging` in Chrome and tick **Allow remote debugging for this browser instance**. If Chrome ever asks whether to allow remote debugging, click **Allow**.

Don't want summaries? Run setup with `--no-summary` and skip this step.

### 4. Check it

```bash
npx github:numandev1/slack-huddle-obsidian doctor
```

All ✅ means you're done. Join a huddle.

---

## What you get

Join huddles as usual. Captions turn on by themselves. Your vault gets:

```
Meetings/
  Slack - Acme/
    2026-10-28 1639 Huddle - Jane Doe.md        ← transcript, written as you talk
MeetingSummary/
  Slack - Acme/
    2026-10-28 1639 Huddle - Jane Doe.md        ← summary, written when the huddle ends
```

A transcript note looks like this:

```markdown
---
title: 'Huddle - Jane Doe'
meetingSoftware: 'Slack huddle'
duration: '24m'
participants: ['Jane Doe', 'You']
tags: [meeting, transcript]
---

## Transcript

**Jane Doe** — 28/10/2026, 04:39 PM

Shall we start with the release plan?
```

The summary has key points, decisions and action items, and links back to the transcript. When it's saved you get a **Meeting summary saved** notification.

The transcript is saved while the huddle is still running, so a crash doesn't lose it.

---

## Commands

| Command | What it does |
|---|---|
| `setup` | Install, or update to the latest version |
| `doctor` | Check that everything works, and say how to fix what doesn't |
| `restart-slack` | Reopen Slack the right way (use instead of the Dock) |
| `logs` | Follow the watcher log |
| `uninstall` | Remove it. Add `--purge` to also delete settings and the log. Your notes are never touched. |

Run each as `npx github:numandev1/slack-huddle-obsidian <command>`.

### Setup options

| Option | Default | |
|---|---|---|
| `--vault <path>` | asks | Obsidian vault folder |
| `--no-summary` | | Only save transcripts, no ChatGPT |
| `--meetings-folder <name>` | `Meetings` | Folder for transcripts |
| `--summary-folder <name>` | `MeetingSummary` | Folder for summaries |
| `--port <n>` | `9333` | Slack debug port |
| `--chrome <dir>` | `~/Library/Application Support/Google/Chrome` | Chrome user data folder |
| `-y`, `--yes` | | Don't ask questions |

### Config file

Settings are saved in `~/.slack-huddle-obsidian/config.json`. After editing it, run `setup -y`.

| Key | Default | |
|---|---|---|
| `autoCaptions` | `true` | Turn captions on in each huddle |
| `notifications` | `true` | Show macOS notifications |
| `slackUserDataDir` | next to Slack's own profile | Where the tool's Slack profile lives (see below) |

---

## Troubleshooting

Start with `doctor`. It names the problem and the fix.

| Symptom | Fix |
|---|---|
| No notes at all | Slack was probably opened from the Dock. Run `restart-slack`. |
| Slack opens and closes straight away, or setup says *"Slack did not open its debug port"* | You're on Slack 4.53+ with an older version of this tool. Run `setup` again. |
| Slack asks you to sign in | Your normal Slack profile couldn't be copied. Sign in once; it's remembered after that. |
| Transcript saved, summary failed | The notification says why. Usually Chrome is closed, remote debugging is off, or you're signed out of ChatGPT. |
| *"No captions were captured"* | Captions couldn't be turned on. Turn them on by hand: huddle **⋯ → Show captions → Side-by-side**. |
| Words come out garbled | Set the huddle language in Slack to the language being spoken. |
| Lines are duplicated | Two people in one room without headphones. Slack hears everything twice. |

---

## How it works

1. **Slack opens with a debug port.** Slack's desktop app is built on Chromium. Started with `--remote-debugging-port`, it lets a local program read its windows, the same way Chrome DevTools does. The port only listens on `127.0.0.1`.
2. **On its own profile.** Since 4.53, Slack won't use that port on its normal profile. So the tool runs Slack on a separate profile, `Slack-huddle`, next to the normal one (inside Slack's container for the App Store version). The first time, it copies your normal profile there, minus caches, so you stay signed in. From then on the two are separate, which is why opening Slack from the Dock records nothing.
3. **A watcher copies the captions.** A background LaunchAgent spots a huddle, turns on **Show captions → Side-by-side**, and writes each line and speaker to the note.
4. **ChatGPT summarises.** When the huddle ends, it opens a small ChatGPT window in your Chrome, sends the transcript with the summary prompt, saves the answer and closes the window.

Everything lives in `~/.slack-huddle-obsidian` plus two LaunchAgents in `~/Library/LaunchAgents`.

---

## Limits

- **macOS only.**
- **Caption quality is Slack's.** The tool saves what Slack shows; it doesn't transcribe anything itself.
- **Slack updates can break it** if they rename the caption elements. Tested on Slack 4.53; `doctor` warns when your version is different. Please [open an issue](https://github.com/numandev1/slack-huddle-obsidian/issues) if notes stop appearing.
- **Tell people you're keeping notes.** Everyone in the huddle sees captions are on, but saving them is your responsibility.

## License

MIT
