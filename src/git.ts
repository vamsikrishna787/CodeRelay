import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

const MAX_FILE = 2 * 1024 * 1024;

/** Fingerprints of every modified/untracked file (path → hash). `undefined` outside a git repo. */
export function changedFiles(root: string): Record<string, string> | undefined {
  const out = git(root, ['status', '--porcelain', '-uall', '-z']);
  if (out === undefined) return undefined;
  const result: Record<string, string> = {};
  const entries = out.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.startsWith('R') || status.startsWith('C')) i++; // skip rename source
    if (file.startsWith('.coderelay/')) continue;
    const full = path.join(root, file);
    if (!existsSync(full)) {
      result[file] = 'deleted';
      continue;
    }
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      result[file] = st.size > MAX_FILE ? `size:${st.size}:${st.mtimeMs}` : createHash('sha1').update(readFileSync(full)).digest('hex');
    } catch {
      /* unreadable — ignore */
    }
  }
  return result;
}

/** Files changed since `baseline` was taken. */
export function changedSince(root: string, baseline: Record<string, string> | undefined): string[] {
  const current = changedFiles(root);
  if (!current) return [];
  return Object.keys(current).filter((f) => !baseline || baseline[f] !== current[f]);
}

/** Lines added/removed for the given files vs HEAD (untracked files count as all-added). */
export function lineStats(root: string, files: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!files.length) return { added, removed };
  const counted = new Set<string>();
  const out = git(root, ['diff', '--numstat', 'HEAD', '--', ...files]) ?? '';
  for (const line of out.split('\n')) {
    const [a, r, file] = line.split('\t');
    if (!file) continue;
    counted.add(file);
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  for (const f of files) {
    if (counted.has(f)) continue;
    const content = readText(root, f);
    if (content !== undefined) added += content.split('\n').length;
  }
  return { added, removed };
}

export function readText(root: string, file: string): string | undefined {
  const full = path.join(root, file);
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    const buf = readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}
