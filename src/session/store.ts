import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEvent, SessionState } from './session.js';

export interface SessionListing {
  id: string;
  title: string;
  status: SessionState['status'];
  createdAt: string;
  updatedAt: string;
  tasks: number;
  costUsd: number;
}

export interface SessionStore {
  load(id: string): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  appendEvent(id: string, event: SessionEvent): Promise<void>;
  readEvents(id: string): Promise<SessionEvent[]>;
  list(): Promise<SessionListing[]>;
  delete(id: string): Promise<void>;
}

function listing(s: SessionState): SessionListing {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    tasks: s.tasks.length,
    costUsd: Math.round(s.invocations.reduce((sum, r) => sum + r.costUsd, 0) * 1e6) / 1e6,
  };
}

/**
 * Stores each session as `<dir>/<id>/state.json` (current snapshot, written atomically)
 * plus `<dir>/<id>/events.jsonl` (append-only full history, survives compaction).
 */
export class FileSessionStore implements SessionStore {
  readonly dir: string;

  constructor(dir = path.join(process.cwd(), '.coderelay', 'sessions')) {
    this.dir = path.resolve(dir);
  }

  private sessionDir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.dir, id);
  }

  async load(id: string): Promise<SessionState | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.sessionDir(id), 'state.json'), 'utf8')) as SessionState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async save(state: SessionState): Promise<void> {
    const dir = this.sessionDir(state.id);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await renameWithRetry(tmp, file);
  }

  async appendEvent(id: string, event: SessionEvent): Promise<void> {
    const dir = this.sessionDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(id: string): Promise<SessionEvent[]> {
    try {
      const raw = await fs.readFile(path.join(this.sessionDir(id), 'events.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async list(): Promise<SessionListing[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const states = await Promise.all(entries.map((id) => this.load(id).catch(() => undefined)));
    return states
      .filter((s): s is SessionState => Boolean(s))
      .map(listing)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.sessionDir(id), { recursive: true, force: true });
  }
}

/** Windows can briefly lock the target file (antivirus, OneDrive sync); retry the rename. */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 25 * 2 ** i));
    }
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly states = new Map<string, SessionState>();
  private readonly events = new Map<string, SessionEvent[]>();

  async load(id: string) {
    const s = this.states.get(id);
    return s ? (structuredClone(s) as SessionState) : undefined;
  }
  async save(state: SessionState) {
    this.states.set(state.id, structuredClone(state));
  }
  async appendEvent(id: string, event: SessionEvent) {
    this.events.set(id, [...(this.events.get(id) ?? []), event]);
  }
  async readEvents(id: string) {
    return this.events.get(id) ?? [];
  }
  async list() {
    return [...this.states.values()].map(listing).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async delete(id: string) {
    this.states.delete(id);
    this.events.delete(id);
  }
}
