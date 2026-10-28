// Slack huddle → Obsidian transcriber, the Slack companion to numandev1/MeetingTranscriptToObsidian.
// Reads live huddle captions from the Slack desktop app over its Chromium DevTools socket
// (Slack must be started with --remote-debugging-port=$PORT). Every huddle gets a transcript note
// in Meetings/; when it ends, ChatGPT (in the user's Chrome) writes a summary note into
// MeetingSummary/ and a macOS notification says so.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSummaryPrompt, summarizeWithChatGpt } from './chatgpt.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig();
const PORT = process.env.SLACK_CDP_PORT || config.port;
const VAULT = process.env.OBSIDIAN_VAULT || config.vaultPath;
if (!VAULT) { console.error('No Obsidian vault configured. Run: npx slack-huddle-obsidian setup'); process.exit(1); }
const TRANSCRIPT_DIR = join(VAULT, config.meetingsFolder);
const SUMMARY_DIR = join(VAULT, config.summaryFolder);
const POLL_MS = 2000;
const END_AFTER_POLLS = 3; // huddle UI gone this many polls in a row → huddle over
const CAPTION_RETRY_MS = 15000;
const CAPTION_MAX_TRIES = 3;

mkdirSync(TRANSCRIPT_DIR, { recursive: true });
mkdirSync(SUMMARY_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Runs inside each Slack renderer. Idempotent. Holds the captions of the current huddle only:
// they are cleared when the huddle UI goes away, because the main window outlives huddles.
const INJECT = `(() => {
  if (window.__slackTx3) return;
  // current markup: p-huddle_event_log__*; older builds: p-huddle_closed_caption_event__*
  const TEXT = '[data-qa="huddle_transcribe_event"], [class*="p-huddle_closed_caption_event__transcription"]';
  const NAME = '[class*="p-huddle_event_log__member_name"], [class*="p-huddle_closed_caption_event__member_name"]';
  const state = { entries: [], byKey: new Map(), byEl: new WeakMap(), lastName: '' };
  const active = () => !!document.querySelector('[data-qa="huddle_toolbar__leave_button"], [data-qa="huddle_channel_header_button__leave_button"]');
  const scan = () => {
    if (!active()) {
      if (state.entries.length) Object.assign(state, { entries: [], byKey: new Map(), byEl: new WeakMap(), lastName: '' });
      return;
    }
    for (const tEl of document.querySelectorAll(TEXT)) {
      const row = tEl.closest('[data-item-key]') || tEl.closest('[class*="__base_event"], [class*="closed_caption_event"]') || tEl.parentElement;
      const key = row.dataset?.itemKey;
      const text = [...row.querySelectorAll(TEXT)].map(e => e.textContent.trim()).filter(Boolean).join(' ');
      if (!text) continue;
      // consecutive lines from one speaker may omit the name; inherit it from the previous row
      const name = (row.querySelector(NAME)?.textContent || '').trim()
        || (key && state.byKey.get(String(key - 1))?.name) || state.lastName || 'Unknown';
      state.lastName = name;
      let e = key ? state.byKey.get(key) : state.byEl.get(row);
      if (!e) {
        e = { key: key ?? null, name, text, t: Date.now(), u: Date.now() };
        state.entries.push(e);
        if (key) state.byKey.set(key, e); else state.byEl.set(row, e);
      } else if (e.text !== text || e.name !== name) { e.text = text; e.name = name; e.u = Date.now(); }
    }
  };
  new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  setInterval(scan, 1000);
  window.__slackTx3 = {
    state,
    read: () => ({
      active: active(),
      captionsOn: !!document.querySelector(TEXT + ', [aria-label="Transcript"], .p-huddle_event_log__header'),
      hasMenu: !!document.querySelector('[data-qa="huddle_toolbar_menu_button"]'),
      huddleTitle: document.querySelector('[data-qa="huddle_window_titlebar_title"], [data-qa="huddle_details_title"]')?.textContent?.trim() || '',
      title: document.title,
      entries: state.entries,
    }),
  };
})()`;

// ⋯ menu → Show captions → Side-by-side (the full transcript panel). Leaves it alone if already on.
const ENABLE_CAPTIONS = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const menu = document.querySelector('[data-qa="huddle_toolbar_menu_button"]');
  if (!menu) return 'no menu';
  menu.click(); await wait(600);
  const show = [...document.querySelectorAll('[role^="menuitem"]')].find(e => /^show captions/i.test(e.textContent.trim()));
  if (!show) { esc(); return 'no captions item'; }
  if (!show.getAttribute('aria-haspopup')) { show.click(); return 'clicked show captions'; }
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) show.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  await wait(600);
  const side = [...document.querySelectorAll('[role^="menuitem"]')].find(e => /side-by-side/i.test(e.textContent));
  if (!side) { esc(); return 'no side-by-side item'; }
  if (side.getAttribute('aria-checked') === 'true') { esc(); return 'already on'; }
  side.click(); await wait(300);
  return 'enabled';
})()`;

const targets = new Map(); // targetId → { ws, nextId, pending }
let meeting = null;
let inactivePolls = 0;

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const conn = { ws, nextId: 1, pending: new Map() };
    ws.onopen = () => resolve(conn);
    ws.onerror = reject;
    ws.onclose = () => targets.delete(target.id);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      const p = conn.pending.get(m.id);
      if (p) { conn.pending.delete(m.id); p(m); }
    };
  });
}

function evaluate(conn, expression) {
  return new Promise(resolve => {
    const id = conn.nextId++;
    conn.pending.set(id, m => resolve(m.result?.result?.value));
    conn.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

const pad = n => String(n).padStart(2, '0');
const INVALID_NOTE_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
const yaml = v => `'${String(v).replace(/'/g, "''")}'`;
// same shape as the extension's notes: 28/10/2026, 03:48 PM
const stamp = ms => new Date(ms).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();

function duration(m) {
  const total = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000));
  return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`;
}

function meetingTitle(reads) {
  // the pop-out window is titled "<who/where> - <workspace> - Slack"; the main one adds "(DM)"/"(Channel)" and unread counts
  const fromTitlebar = reads.map(r => r.huddleTitle).find(Boolean);
  const raw = fromTitlebar || reads.find(r => r.hasMenu)?.title || reads[0]?.title || '';
  const who = raw.replace(/^[!*]\s*/, '').split(' - ')[0].replace(/\s*\((DM|Channel)\)\s*/i, '').trim();
  return who ? `Huddle - ${who}` : 'Slack huddle';
}

// notes are filed per workspace, beside the extension's per-account folders
function workspaceFolder(reads) {
  const raw = reads.find(r => r.hasMenu)?.title || reads[0]?.title || '';
  const ws = (raw.split(' - ')[1] || '').replace(INVALID_NOTE_NAME_CHARS, '').trim();
  return ws ? `Slack - ${ws}` : 'Slack';
}

function noteName(m) {
  // fixed at first write: startedAt can still move earlier, and the file must not be renamed
  if (m.name) return m.name;
  const d = new Date(m.startedAt);
  const title = m.title.replace(INVALID_NOTE_NAME_CHARS, '').trim() || 'Slack huddle';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${title}`;
}

// consecutive captions from one speaker become one block, as in the extension's notes
function blocks(m) {
  const out = [];
  for (const e of [...m.entries.values()].sort((a, b) => a.t - b.t)) {
    const prev = out.at(-1);
    if (prev && prev.name === e.name && e.t - prev.u < 30000) { prev.text += ' ' + e.text; prev.u = e.u; }
    else out.push({ ...e });
  }
  return out;
}

const participants = m => [...new Set([...m.entries.values()].map(e => e.name))].filter(n => n && n !== 'Unknown');

function writeAtomic(file, body) {
  writeFileSync(file + '.tmp', body);
  renameSync(file + '.tmp', file);
}

function transcriptMarkdown(m) {
  const people = participants(m);
  let note = '---\n';
  note += `title: ${yaml(m.title)}\n`;
  note += `meetingSoftware: ${yaml('Slack huddle')}\n`;
  note += `created: ${yaml(new Date(m.startedAt).toISOString())}\n`;
  note += `ended: ${yaml(new Date(m.endedAt).toISOString())}\n`;
  note += `duration: ${yaml(duration(m))}\n`;
  if (people.length) note += 'participants:\n' + people.map(n => `  - ${yaml(n)}\n`).join('');
  note += 'tags:\n  - meeting\n  - transcript\n---\n\n';
  note += `# ${m.title}\n\n## Transcript\n\n`;
  const bs = blocks(m);
  note += bs.length ? bs.map(b => `**${b.name}** — ${stamp(b.t)}\n\n${b.text}\n\n`).join('') : '_No transcript captured._\n\n';
  return note;
}

function summaryMarkdown(m, summary) {
  let note = '---\n';
  note += `title: ${yaml(m.title + ' (summary)')}\n`;
  note += `meetingSoftware: ${yaml('Slack huddle')}\n`;
  note += `created: ${yaml(new Date(m.startedAt).toISOString())}\n`;
  note += `duration: ${yaml(duration(m))}\n`;
  note += 'tags:\n  - meeting\n  - summary\n---\n\n';
  note += `# ${m.title}\n\nFull transcript: [[${noteName(m)}]]\n\n${summary.trim()}\n`;
  return note;
}

function toast(title, message) {
  if (!config.notifications) return;
  const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`]);
}

function saveTranscript(m) {
  m.name = noteName(m);
  mkdirSync(join(TRANSCRIPT_DIR, m.folder), { recursive: true });
  writeAtomic(join(TRANSCRIPT_DIR, m.folder, noteName(m) + '.md'), transcriptMarkdown(m));
}

// ChatGPT runs one at a time: each one opens a window, and two would fight over it
let summaryQueue = Promise.resolve();

async function finishMeeting(m) {
  if (!m.entries.size) {
    log('huddle ended with no captions', m.title);
    toast('Slack huddle ended', `No captions were captured for ${m.title}.`);
    return;
  }
  saveTranscript(m);
  log('transcript saved', noteName(m));
  if (config.summary === 'none') {
    toast('Meeting transcript saved', `${m.title} — the transcript is in Obsidian.`);
    return;
  }
  summaryQueue = summaryQueue.then(async () => {
    const transcript = blocks(m).map(b => `${b.name} (${stamp(b.t)})\n${b.text}`).join('\n\n');
    try {
      const summary = await summarizeWithChatGpt(
        buildSummaryPrompt({ title: m.title, startedAt: m.startedAt, participants: participants(m), transcript }),
        { chromeUserDataDir: config.chromeUserDataDir });
      mkdirSync(join(SUMMARY_DIR, m.folder), { recursive: true });
      writeAtomic(join(SUMMARY_DIR, m.folder, noteName(m) + '.md'), summaryMarkdown(m, summary));
      log('summary saved', noteName(m));
      toast('Meeting summary saved', `${m.title} — summary and transcript are in Obsidian.`);
    } catch (e) {
      log('summary failed', e.message);
      toast('Transcript saved, summary failed', `${m.title}: ${e.message}`);
    }
  });
}

async function tick() {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch { return; } // Slack not running with the debug port
  const reads = [];
  for (const t of list) {
    // the pop-out huddle window is an about:blank child of the main client
    if (t.type !== 'page' || !(t.url.startsWith('https://app.slack.com') || / - Slack\b/.test(t.title))) continue;
    let conn = targets.get(t.id);
    if (!conn) {
      try { conn = await connect(t); } catch { continue; }
      targets.set(t.id, conn);
      log('attached', t.title);
    }
    const r = await evaluate(conn, `${INJECT}; window.__slackTx3.read()`);
    if (r) reads.push({ ...r, conn, targetId: t.id });
  }

  const live = reads.filter(r => r.active);
  if (!live.length) {
    if (meeting && ++inactivePolls >= END_AFTER_POLLS) {
      const done = meeting; meeting = null;
      done.endedAt = done.lastSeen;
      log('huddle ended', done.title, `${done.entries.size} caption lines`);
      finishMeeting(done).catch(e => log('finish error', e.message));
    }
    return;
  }
  inactivePolls = 0;
  if (!meeting) {
    meeting = { title: meetingTitle(live), folder: workspaceFolder(live), startedAt: Date.now(), endedAt: Date.now(), entries: new Map(), captionTries: 0, lastCaptionTry: 0, written: 0 };
    log('huddle started', meeting.title);
  }
  meeting.lastSeen = Date.now();
  meeting.endedAt = Date.now();
  if (meeting.title === 'Slack huddle') meeting.title = meetingTitle(live);

  // both windows can show the same caption list; item keys are shared, so merge on them
  for (const r of live) {
    r.entries.forEach((e, i) => meeting.entries.set(e.key != null ? `k${e.key}` : `${r.targetId}:${i}`, e));
    // first captions may predate the watcher noticing the huddle
    for (const e of r.entries) if (e.t < meeting.startedAt) meeting.startedAt = e.t;
  }

  if (config.autoCaptions && !live.some(r => r.captionsOn) && meeting.captionTries < CAPTION_MAX_TRIES && Date.now() - meeting.lastCaptionTry > CAPTION_RETRY_MS) {
    const host = live.find(r => r.hasMenu);
    if (host) {
      meeting.captionTries++; meeting.lastCaptionTry = Date.now();
      log('turning captions on:', await evaluate(host.conn, ENABLE_CAPTIONS));
    }
  }

  // keep the transcript note current while the huddle runs, so a crash loses nothing
  const version = [...meeting.entries.values()].reduce((s, e) => Math.max(s, e.u), 0);
  if (meeting.entries.size && version !== meeting.written) {
    meeting.written = version;
    saveTranscript(meeting);
  }
}

export { finishMeeting };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  log(`watching Slack on 127.0.0.1:${PORT} → ${TRANSCRIPT_DIR}`);
  let running = false;
  setInterval(async () => {
    if (running) return; // ENABLE_CAPTIONS can outlast a poll
    running = true;
    try { await tick(); } catch (e) { log('tick error', e.message); } finally { running = false; }
  }, POLL_MS);
}
