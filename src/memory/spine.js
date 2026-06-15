// src/memory/spine.js — make the bridge the actual session spine (docs/memory-bridge/07).
// Auto-LOAD: a SessionStart hook injects the brief. Auto-SAVE: a Stop hook consolidates the transcript.
// The memory store becomes the source of truth; .agent-memory/MEMORY.md becomes a generated projection.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { briefMarkdown } from './store.js';

// repo/bin/kb.js  (this file is repo/src/memory/spine.js)
const KB_BIN = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'kb.js');
const START_MARK = 'brief --hook';
const STOP_MARK = 'consolidate --from-transcript';

export function defaultSettingsPath() { return join(homedir(), '.claude', 'settings.json'); }
function nodeCmd(args) { return `node "${KB_BIN}" ${args}`; }

// SessionStart hook output: inject the brief as additionalContext.
export function briefHookOutput(opts = {}) {
  let ctx = '';
  try { ctx = briefMarkdown(opts); } catch { ctx = ''; }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx || '(Kaiba: no memories yet)' } });
}

function readSettings(p) {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { throw new Error(`${p} is not valid JSON — refusing to overwrite it`); }
}

export function installSpine({ settingsPath = defaultSettingsPath(), print = false } = {}) {
  const settings = readSettings(settingsPath);
  settings.hooks = settings.hooks || {};
  const added = [];
  const ensure = (event, cmd, marker) => {
    settings.hooks[event] = settings.hooks[event] || [];
    const already = settings.hooks[event].some(g => (g.hooks || []).some(h => typeof h.command === 'string' && h.command.includes(marker)));
    if (!already) { settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd }] }); added.push(event); }
  };
  ensure('SessionStart', nodeCmd(START_MARK), START_MARK);
  ensure('Stop', nodeCmd(STOP_MARK), STOP_MARK);
  const out = JSON.stringify(settings, null, 2);
  if (print) return { settingsPath, added, preview: out };
  mkdirSync(dirname(settingsPath), { recursive: true });
  let backedUp = false;
  if (existsSync(settingsPath)) { copyFileSync(settingsPath, settingsPath + '.bak-kaiba'); backedUp = true; }
  writeFileSync(settingsPath, out);
  return { settingsPath, added, backedUp };
}

export function uninstallSpine({ settingsPath = defaultSettingsPath() } = {}) {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return { settingsPath, removed: 0 };
  let removed = 0;
  for (const event of ['SessionStart', 'Stop']) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter(g => {
      const keep = !(g.hooks || []).some(h => typeof h.command === 'string' && h.command.includes('kb.js') && (h.command.includes(START_MARK) || h.command.includes(STOP_MARK)));
      if (!keep) removed++;
      return keep;
    });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.bak-kaiba');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, removed };
}

export function spineStatus({ settingsPath = defaultSettingsPath() } = {}) {
  if (!existsSync(settingsPath)) return { installed: false, sessionStart: false, stop: false, settingsPath };
  let s; try { s = readSettings(settingsPath); } catch { return { installed: false, error: 'invalid json', settingsPath }; }
  const has = (event, marker) => ((s.hooks && s.hooks[event]) || []).some(g => (g.hooks || []).some(h => h.command && h.command.includes(marker)));
  const ss = has('SessionStart', START_MARK), st = has('Stop', STOP_MARK);
  return { installed: ss && st, sessionStart: ss, stop: st, settingsPath };
}

// Extract human-readable text from a Claude Code transcript (JSONL) for consolidation.
export function extractTranscriptText(jsonl) {
  const out = [];
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message || e;
    const role = msg.role || e.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const c = msg.content;
    if (typeof c === 'string') out.push(`${role}: ${c}`);
    else if (Array.isArray(c)) for (const part of c) if (part && part.type === 'text' && part.text) out.push(`${role}: ${part.text}`);
  }
  return out.join('\n').slice(0, 20000);
}
