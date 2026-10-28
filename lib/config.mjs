// Shared paths and the user's config.json, written by `slack-huddle-obsidian setup`.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const APP_DIR = process.env.SLACK_HUDDLE_OBSIDIAN_HOME || join(HOME, '.slack-huddle-obsidian');
export const CONFIG_FILE = join(APP_DIR, 'config.json');
export const LOG_FILE = join(APP_DIR, 'watcher.log');

export const DEFAULTS = {
  vaultPath: '',
  meetingsFolder: 'Meetings',
  summaryFolder: 'MeetingSummary',
  port: 9333,
  summary: 'chatgpt', // 'chatgpt' | 'none'
  chromeUserDataDir: join(HOME, 'Library/Application Support/Google/Chrome'),
  autoCaptions: true,
  notifications: true,
};

export function loadConfig() {
  const saved = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  return { ...DEFAULTS, ...saved };
}

export function saveConfig(config) {
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
