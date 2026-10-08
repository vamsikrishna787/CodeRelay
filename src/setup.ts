import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, paths } from './state.js';
import { AGENT_FILES, BLOCK_END, BLOCK_START, DEFAULT_SESSION_MD, MANAGED, WORKFLOW } from './templates.js';

export const AUTO_APPROVE_KEY = '/^npx coderelay\\b/';

/**
 * Install the Copilot workflow into a project. Safe to run repeatedly:
 * managed files are refreshed, user-edited files are left alone.
 */
export function install(root: string, opts: { force?: boolean } = {}): string[] {
  const log: string[] = [];
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  // 1. Agents (Orchestrator + specialists)
  for (const { file, content } of AGENT_FILES) {
    const full = path.join(root, file);
    if (!existsSync(full)) {
      write(file, content);
      log.push(`added   ${file}`);
    } else {
      const current = readFileSync(full, 'utf8');
      if (current === content) continue;
      if (current.includes(MANAGED) || opts.force) {
        write(file, content);
        log.push(`updated ${file}`);
      } else {
        log.push(`kept    ${file} (you edited it)`);
      }
    }
  }

  // 2. Workflow rules Copilot reads in every chat
  const instr = path.join('.github', 'copilot-instructions.md');
  const instrFull = path.join(root, instr);
  const existing = existsSync(instrFull) ? readFileSync(instrFull, 'utf8') : '';
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  let next: string;
  if (start >= 0 && end > start) next = existing.slice(0, start) + WORKFLOW.trimEnd() + existing.slice(end + BLOCK_END.length);
  else next = existing ? `${existing.trimEnd()}\n\n${WORKFLOW}` : WORKFLOW;
  if (next !== existing) {
    write(instr, next);
    log.push(`${existing ? 'updated' : 'added  '} ${instr}`);
  }

  // 3. Let Copilot run `npx coderelay …` without an approval prompt each time
  const settingsRel = path.join('.vscode', 'settings.json');
  const settingsFull = path.join(root, settingsRel);
  let settings: Record<string, unknown> = {};
  let parsed = true;
  if (existsSync(settingsFull)) {
    try {
      const raw = readFileSync(settingsFull, 'utf8');
      const clean = stripJsonComments(raw);
      settings = JSON.parse(clean) as Record<string, unknown>;
      // Rewriting would drop the user's comments; ask them to add the line instead.
      if (clean.replace(/\s/g, '') !== raw.replace(/\s/g, '')) parsed = false;
    } catch {
      parsed = false;
    }
  }
  const key = 'chat.tools.terminal.autoApprove';
  const rules = (settings[key] ?? {}) as Record<string, unknown>;
  if (!parsed) {
    log.push(`skipped ${settingsRel} (could not parse); add  "${key}": { "${AUTO_APPROVE_KEY.replace(/\\/g, '\\\\')}": true }`);
  } else if (rules[AUTO_APPROVE_KEY] !== true) {
    settings[key] = { ...rules, [AUTO_APPROVE_KEY]: true };
    write(settingsRel, `${JSON.stringify(settings, null, 2)}\n`);
    log.push(`updated ${settingsRel} (auto-approve "npx coderelay" commands)`);
  }

  // 4. Session folder
  const p = paths(root);
  if (!existsSync(p.config)) {
    write(path.relative(root, p.config), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    log.push(`added   ${path.relative(root, p.config)}`);
  }
  if (!existsSync(p.session)) write(path.relative(root, p.session), DEFAULT_SESSION_MD);

  return log;
}

/** Remove // and /* *\/ comments and trailing commas (VS Code settings are JSONC). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
