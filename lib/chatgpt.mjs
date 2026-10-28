// Summarise a transcript with the ChatGPT web app in the user's real Chrome, over its DevTools socket.
// Same approach and prompt as numandev1/MeetingTranscriptToObsidian (src/background-script/summarizer.ts),
// but driven from outside the browser: Chrome's remote debugging must be allowed at chrome://inspect,
// which writes DevToolsActivePort.
import { readFileSync } from 'node:fs';

export const END_MARKER = '<!--meetingtranscript-end-->';
const MAX_TRANSCRIPT_CHARS = 100000;
const RESPONSE_TIMEOUT_MS = 180000;
const STABLE_POLLS_REQUIRED = 8;

const SEL = {
  composer: '#prompt-textarea, div.ProseMirror[contenteditable="true"]',
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send"], button[type="submit"]',
  stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop"], button[aria-label^="Stop"]',
  assistantMessage: '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"]',
  codeBlock: 'pre code, [data-markdown-copy="code-block"] [dir="ltr"]',
  login: 'a[href*="/auth/login"], button[data-testid="login-button"]',
};

export const DEFAULT_SUMMARY_INSTRUCTIONS = [
  'Summarise the following meeting transcript. The transcript comes from automatic captions, so expect some transcription errors and ignore them.',
  '',
  'Reply with a single fenced code block containing markdown, and nothing outside it.',
  `The very last line inside the block must be exactly ${END_MARKER}`,
  'Inside the block use exactly these sections:',
  '',
  '## Summary',
  'Two to four sentences.',
  '',
  '## Key points',
  'Short bullets.',
  '',
  '## Decisions',
  'Short bullets, or "None recorded".',
  '',
  '## Action items',
  'Bullets shaped "- [ ] Owner — task", or "None recorded".',
].join('\n');

export function buildSummaryPrompt({ title, startedAt, participants, transcript }) {
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[transcript truncated]';
  return [
    DEFAULT_SUMMARY_INSTRUCTIONS, '',
    `Meeting: ${title}`,
    `Date: ${new Date(startedAt).toLocaleString()}`,
    participants.length ? `Participants: ${participants.join(', ')}` : '',
    '', 'Transcript:', '', transcript,
  ].filter(l => l !== '').join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function connectChrome(chromeUserDataDir = `${process.env.HOME}/Library/Application Support/Google/Chrome`) {
  const file = `${chromeUserDataDir}/DevToolsActivePort`;
  let port, path;
  try { [port, path] = readFileSync(file, 'utf8').trim().split('\n'); }
  catch { throw new Error('Chrome remote debugging is off (enable it at chrome://inspect/#remote-debugging)'); }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to Chrome')); });
  const send = (method, params = {}, sessionId) => new Promise(resolve => {
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  return { ws, send };
}

/** Returns the summary markdown, or throws with a readable reason. */
export async function summarizeWithChatGpt(prompt, { chromeUserDataDir } = {}) {
  const { ws, send } = await connectChrome(chromeUserDataDir);
  let targetId;
  try {
    // CDP can only create tabs in its default context, which is not necessarily the signed-in
    // profile. So a page already open in the right profile (one with ChatGPT open, else the
    // profile with the most tabs) opens the window itself, and it inherits that profile.
    // Background tabs are not rendered, so the composer only mounts in a visible window.
    const { result: { targetInfos } } = await send('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page' && /^https?:/.test(t.url));
    const counts = {};
    for (const p of pages) counts[p.browserContextId] = (counts[p.browserContextId] || 0) + 1;
    const context = pages.find(p => p.url.startsWith('https://chatgpt.com'))?.browserContextId
      ?? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const opener = pages.find(p => p.browserContextId === context && p.url.startsWith('https://chatgpt.com'))
      ?? pages.find(p => p.browserContextId === context);
    if (!opener) throw new Error('no open Chrome tab to start ChatGPT from');
    const tag = `mtt-${Date.now()}`;
    const { result: { sessionId: openerSession } } = await send('Target.attachToTarget', { targetId: opener.targetId, flatten: true });
    await send('Runtime.evaluate', {
      expression: `window.open('https://chatgpt.com/#${tag}', '_blank', 'noopener,popup,width=520,height=640,left=40,top=60')`,
      userGesture: true,
    }, openerSession);
    await send('Target.detachFromTarget', { sessionId: openerSession });
    for (let i = 0; i < 40 && !targetId; i++) {
      await sleep(250);
      const { result } = await send('Target.getTargets');
      targetId = result.targetInfos.find(t => t.type === 'page' && t.url.includes(tag))?.targetId;
    }
    if (!targetId) throw new Error('Chrome did not open the ChatGPT window');
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    // a background tab never has focus; emulate it so the ProseMirror composer accepts input
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result?.result?.value;

    let state;
    for (let i = 0; i < 60; i++) {
      state = await evaluate(`({ composer: !!document.querySelector(${JSON.stringify(SEL.composer)}), login: [...document.querySelectorAll(${JSON.stringify(SEL.login)})].some(e => e.offsetParent) })`);
      // the server-rendered shell shows a login button until the session hydrates
      if (state?.composer && !state?.login) break;
      await sleep(500);
    }
    if (state?.login) throw new Error('you are signed out of ChatGPT in Chrome');
    if (!state?.composer) throw new Error("ChatGPT's message box was not found (the page may have changed)");

    await evaluate(`document.querySelector(${JSON.stringify(SEL.composer)}).focus()`);
    await send('Input.insertText', { text: prompt }, sessionId);

    let sent = false;
    for (let i = 0; i < 20 && !sent; i++) {
      await sleep(250);
      sent = await evaluate(`(() => {
        const c = document.querySelector(${JSON.stringify(SEL.composer)});
        if (!c || !(c.innerText || '').trim()) return false;
        const b = (c.closest('form') ?? document).querySelector(${JSON.stringify(SEL.sendButton)});
        if (!b || b.disabled) return false;
        b.click(); return true;
      })()`);
    }
    if (!sent) throw new Error('the send button was not found or stayed disabled');

    const startedAt = Date.now();
    let lastText = '', stable = 0, sawGenerating = false;
    while (Date.now() - startedAt < RESPONSE_TIMEOUT_MS) {
      await sleep(1000);
      const raw = await evaluate(`(() => {
        const all = document.querySelectorAll(${JSON.stringify(SEL.assistantMessage)});
        const last = all[all.length - 1];
        return { code: last?.querySelector(${JSON.stringify(SEL.codeBlock)})?.textContent ?? '', msg: last?.textContent ?? '',
                 busy: !!document.querySelector(${JSON.stringify(SEL.stopButton)}),
                 limit: /reached (our|the) limit|too many requests|usage limit/i.test(document.body.textContent || '') };
      })()`);
      if (!raw) continue;
      if (raw.busy) sawGenerating = true;
      const text = (raw.code.trim() || raw.msg.trim());
      if (text.includes(END_MARKER)) return text.split(END_MARKER).join('').trim();
      if (raw.limit && !text) throw new Error('ChatGPT reported a usage limit');
      if (text && text === lastText && !raw.busy && sawGenerating) { if (++stable >= STABLE_POLLS_REQUIRED) return text; }
      else { stable = 0; lastText = text; }
    }
    throw new Error(`the answer never finished${lastText ? ` (${lastText.length} characters arrived)` : ''}`);
  } finally {
    if (targetId) await send('Target.closeTarget', { targetId }).catch(() => {});
    ws.close();
  }
}
