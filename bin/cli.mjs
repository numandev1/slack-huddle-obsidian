#!/usr/bin/env node
// slack-huddle-obsidian: installs, checks and removes the Slack huddle → Obsidian watcher.
// Everything lives in ~/.slack-huddle-obsidian plus two LaunchAgents; nothing goes in /Applications.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { APP_DIR, CONFIG_FILE, LOG_FILE, HOME, DEFAULTS, loadConfig, saveConfig } from '../lib/config.mjs';
import { connectChrome } from '../lib/chatgpt.mjs';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const RUNTIME_DIR = join(APP_DIR, 'app');
const AGENTS_DIR = join(HOME, 'Library/LaunchAgents');
const WATCHER_LABEL = 'io.github.numandev1.slack-huddle-obsidian';
const SLACK_LABEL = 'io.github.numandev1.slack-huddle-obsidian.launch-slack';
const OBSIDIAN_CONFIG = join(HOME, 'Library/Application Support/obsidian/obsidian.json');
const SLACK_APP = '/Applications/Slack.app';
const TESTED_SLACK = '4.52';
const UID = process.getuid();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = s => console.log(`  ✅ ${s}`);
const bad = s => console.log(`  ❌ ${s}`);
const warn = s => console.log(`  ⚠️  ${s}`);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--no-summary') flags.summary = 'none';
    else if (a === '--purge') flags.purge = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
      flags[k] = v;
    } else rest.push(a);
  }
  return { command: rest[0] || 'help', flags };
}

async function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer || fallback;
}

const confirm = async (question, flags) => flags.yes || /^y/i.test(await ask(`${question} [Y/n] `, 'y'));
const expandHome = p => p.replace(/^~(?=$|\/)/, HOME);

function obsidianVaults() {
  try {
    return Object.values(JSON.parse(readFileSync(OBSIDIAN_CONFIG, 'utf8')).vaults || {})
      .sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || b.ts - a.ts)
      .map(v => v.path)
      .filter(p => existsSync(p));
  } catch { return []; }
}

async function chooseVault(flags, current) {
  if (flags.vault) return resolve(expandHome(flags.vault));
  const vaults = obsidianVaults();
  if (current && flags.yes) return current;
  if (vaults.length === 1 && !current) {
    if (await confirm(`Save notes to the Obsidian vault at ${vaults[0]}?`, flags)) return vaults[0];
  } else if (vaults.length) {
    console.log('Obsidian vaults on this Mac:');
    vaults.forEach((v, i) => console.log(`  ${i + 1}. ${v}${v === current ? '  (current)' : ''}`));
    const preset = vaults.includes(current) ? String(vaults.indexOf(current) + 1) : current || '1';
    const pick = await ask(`Which vault? [1-${vaults.length}, or a path] (${preset}) `, preset);
    if (/^\d+$/.test(pick) && vaults[pick - 1]) return vaults[pick - 1];
    if (pick) return resolve(expandHome(pick));
  }
  const typed = await ask('Path to your Obsidian vault: ', current);
  if (!typed) throw new Error('No vault given. Run again with --vault "/path/to/vault".');
  return resolve(expandHome(typed));
}

const plist = (label, args, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>${extra}
</dict></plist>
`;

function loadAgent(label, body) {
  const file = join(AGENTS_DIR, `${label}.plist`);
  mkdirSync(AGENTS_DIR, { recursive: true });
  run('launchctl', ['bootout', `gui/${UID}/${label}`]);
  writeFileSync(file, body);
  const r = run('launchctl', ['bootstrap', `gui/${UID}`, file]);
  if (r.status !== 0) throw new Error(`launchctl could not load ${label}: ${r.stderr.trim()}`);
}

function unloadAgent(label) {
  run('launchctl', ['bootout', `gui/${UID}/${label}`]);
  rmSync(join(AGENTS_DIR, `${label}.plist`), { force: true });
}

const agentRunning = label => /state = running/.test(run('launchctl', ['print', `gui/${UID}/${label}`]).stdout || '');
const slackRunning = () => run('pgrep', ['-x', 'Slack']).status === 0;

async function slackPortUp(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

async function restartSlack(port) {
  if (slackRunning()) {
    run('osascript', ['-e', 'quit app "Slack"']);
    for (let i = 0; i < 40 && slackRunning(); i++) await sleep(250);
  }
  run('open', ['-a', 'Slack', '--args', `--remote-debugging-port=${port}`]);
  for (let i = 0; i < 60; i++) { if (await slackPortUp(port)) return true; await sleep(500); }
  return false;
}

async function chromeReachable(dir) {
  let conn;
  try {
    conn = await Promise.race([connectChrome(dir), sleep(4000).then(() => { throw new Error('timed out'); })]);
    const v = await Promise.race([conn.send('Browser.getVersion'), sleep(4000).then(() => null)]);
    return v?.result?.product ? { ok: true, product: v.result.product } : { ok: false, reason: 'Chrome did not answer' };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    conn?.ws.close();
  }
}

async function setup(flags) {
  if (process.platform !== 'darwin') throw new Error('slack-huddle-obsidian only runs on macOS.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Node 22 or newer is needed (this is ${process.version}).`);
  if (!existsSync(SLACK_APP)) warn('Slack.app was not found in /Applications. Install the Slack desktop app first.');

  const previous = existsSync(CONFIG_FILE) ? loadConfig() : null;
  const vaultPath = await chooseVault(flags, previous?.vaultPath);
  if (!existsSync(vaultPath)) throw new Error(`Vault folder does not exist: ${vaultPath}`);
  const config = {
    ...DEFAULTS, ...previous, vaultPath,
    ...(flags.port && { port: Number(flags.port) }),
    ...(flags.summary && { summary: flags.summary }),
    ...(flags['meetings-folder'] && { meetingsFolder: flags['meetings-folder'] }),
    ...(flags['summary-folder'] && { summaryFolder: flags['summary-folder'] }),
    ...(flags.chrome && { chromeUserDataDir: resolve(expandHome(flags.chrome)) }),
  };
  saveConfig(config);

  // copy the runtime out of the npx cache, which can be cleaned at any time
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const f of readdirSync(join(PKG_DIR, 'lib'))) copyFileSync(join(PKG_DIR, 'lib', f), join(RUNTIME_DIR, f));
  writeFileSync(join(RUNTIME_DIR, 'package.json'), JSON.stringify({ type: 'module', version: PKG.version }) + '\n');

  loadAgent(WATCHER_LABEL, plist(WATCHER_LABEL, [process.execPath, join(RUNTIME_DIR, 'watcher.mjs')], `
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>`));
  // only loaded for future logins: bootstrapping it now would `open` Slack straight away
  writeFileSync(join(AGENTS_DIR, `${SLACK_LABEL}.plist`), plist(SLACK_LABEL, ['/usr/bin/open', '-a', 'Slack', '--args', `--remote-debugging-port=${config.port}`]));
  run('launchctl', ['bootout', `gui/${UID}/${SLACK_LABEL}`]);
  run('launchctl', ['enable', `gui/${UID}/${SLACK_LABEL}`]);

  console.log(`\nInstalled v${PKG.version}. Transcripts → ${join(vaultPath, config.meetingsFolder)}`);

  if (!(await slackPortUp(config.port))) {
    const why = slackRunning() ? 'Slack is open without the debug port, so it needs a restart.' : 'Slack is not running.';
    if (await confirm(`${why} (Re)start Slack now?`, flags)) {
      console.log('Restarting Slack…');
      if (!(await restartSlack(config.port))) warn('Slack did not open its debug port. Run `npx slack-huddle-obsidian doctor`.');
    }
  }

  if (config.summary === 'chatgpt' && !(await chromeReachable(config.chromeUserDataDir)).ok) {
    console.log(`
Summaries use ChatGPT in your Chrome. One more step:
  1. In Chrome, open chrome://inspect/#remote-debugging
  2. Tick "Allow remote debugging for this browser instance"
  3. Make sure you are signed in to chatgpt.com in that Chrome
(Or rerun setup with --no-summary to only save transcripts.)`);
    run('open', ['-a', 'Google Chrome', 'chrome://inspect/#remote-debugging']);
  }

  console.log(`
Important: stop Slack opening by itself at login. Right-click Slack in the Dock → Options →
untick "Open at Login" (or remove it in System Settings → General → Login Items).
This tool opens Slack at login itself; if Slack opens itself first, nothing gets recorded.
If you quit Slack, reopen it with:  npx slack-huddle-obsidian restart-slack
`);
  await doctor();
}

async function doctor() {
  console.log('Checking slack-huddle-obsidian:');
  let healthy = true;
  const fail = s => { bad(s); healthy = false; };
  if (!existsSync(CONFIG_FILE)) { fail('Not set up. Run: npx slack-huddle-obsidian setup'); return false; }
  const config = loadConfig();

  existsSync(config.vaultPath) ? ok(`Vault: ${config.vaultPath}`) : fail(`Vault folder is missing: ${config.vaultPath}`);
  agentRunning(WATCHER_LABEL) ? ok('Watcher is running') : fail('Watcher is not running (rerun setup)');
  existsSync(join(AGENTS_DIR, `${SLACK_LABEL}.plist`)) ? ok('Slack opens with the debug port at login') : fail('Slack login launcher is missing (rerun setup)');

  if (existsSync(SLACK_APP)) {
    const version = run('defaults', ['read', `${SLACK_APP}/Contents/Info`, 'CFBundleShortVersionString']).stdout.trim();
    version.startsWith(TESTED_SLACK) ? ok(`Slack ${version}`) : warn(`Slack ${version} — tested with ${TESTED_SLACK}.x; if captions stop being saved, Slack may have changed its page`);
  } else fail('Slack.app is not in /Applications');

  if (await slackPortUp(config.port)) ok(`Slack debug port ${config.port} is open`);
  else if (slackRunning()) fail('Slack is open WITHOUT the debug port. Fix: npx slack-huddle-obsidian restart-slack');
  else warn('Slack is not running (it will be recorded once you open it with restart-slack, or after login)');

  if (config.summary === 'chatgpt') {
    const chrome = await chromeReachable(config.chromeUserDataDir);
    chrome.ok ? ok(`Chrome reachable (${chrome.product}) for ChatGPT summaries`)
      : fail(`Chrome not reachable for summaries: ${chrome.reason}. Enable chrome://inspect/#remote-debugging`);
  } else ok('Summaries are off (transcripts only)');

  if (existsSync(LOG_FILE)) {
    const last = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-3);
    console.log(`\nLast log lines (${LOG_FILE}):\n${last.map(l => '  ' + l).join('\n')}`);
  }
  console.log(healthy ? '\nAll good. Join a huddle and the notes will appear in Obsidian.' : '\nFix the ❌ items above.');
  return healthy;
}

function uninstall(flags) {
  unloadAgent(WATCHER_LABEL);
  unloadAgent(SLACK_LABEL);
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  if (flags.purge) rmSync(APP_DIR, { recursive: true, force: true });
  console.log(`Removed. Your notes in Obsidian were not touched.${flags.purge ? '' : `\nSettings and log are kept in ${APP_DIR} (use --purge to delete them).`}`);
  console.log('Slack keeps running with the debug port until you quit it.');
}

const HELP = `slack-huddle-obsidian v${PKG.version}
Saves a transcript of every Slack huddle to Obsidian, and a ChatGPT summary when it ends.

Usage: npx slack-huddle-obsidian <command> [options]

Commands
  setup            Install or update (asks for your vault)
  doctor           Check that everything is working
  restart-slack    Reopen Slack with the debug port (use instead of the Dock)
  logs             Follow the watcher log
  uninstall        Remove it (add --purge to also delete settings and log)

Setup options
  --vault <path>             Obsidian vault folder
  --no-summary               Only save transcripts, no ChatGPT
  --port <n>                 Slack debug port (default 9333)
  --meetings-folder <name>   Folder for transcripts (default Meetings)
  --summary-folder <name>    Folder for summaries (default MeetingSummary)
  --chrome <dir>             Chrome user data dir (default ~/Library/Application Support/Google/Chrome)
  -y, --yes                  Don't ask questions
`;

const { command, flags } = parseArgs(process.argv.slice(2));
try {
  if (flags.help || command === 'help') console.log(HELP);
  else if (command === 'setup' || command === 'install') await setup(flags);
  else if (command === 'doctor') process.exitCode = (await doctor()) ? 0 : 1;
  else if (command === 'restart-slack') {
    const { port } = loadConfig();
    console.log(await restartSlack(port) ? `Slack is open with debug port ${port}.` : 'Slack did not open its debug port.');
  }
  else if (command === 'logs') execFileSync('tail', ['-n', '40', '-f', LOG_FILE], { stdio: 'inherit' });
  else if (command === 'uninstall') uninstall(flags);
  else { console.log(HELP); process.exitCode = 1; }
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
}
// a Chrome socket that never answered would otherwise keep the process alive
process.exit();
