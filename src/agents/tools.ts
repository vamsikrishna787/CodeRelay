import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolRiskClass } from '../metrics/risk.js';
import type { ToolSchema } from '../types.js';
import { truncate } from '../util.js';

export interface ToolContext {
  agent: string;
  taskId?: string;
  sessionId?: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface Tool {
  schema: ToolSchema;
  /** Drives baseline risk scoring for every call. */
  risk: ToolRiskClass;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

export function defineTool(tool: Tool): Tool {
  return tool;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (required) throw new Error(`Missing string argument "${key}"`);
  return '';
}

/** Resolve a path and refuse anything that escapes the workspace. */
export function resolveInWorkspace(root: string, p: string): string {
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

export interface WorkspaceToolOptions {
  /** Include `run_command`. Off by default. */
  allowCommands?: boolean;
  /** Include `write_file`. On by default. */
  allowWrites?: boolean;
  commandTimeoutMs?: number;
  maxOutputChars?: number;
}

/** File-system and shell tools sandboxed to the workspace root. */
export function createWorkspaceTools(opts: WorkspaceToolOptions = {}): Tool[] {
  const maxOut = opts.maxOutputChars ?? 20_000;
  const tools: Tool[] = [
    {
      risk: 'read',
      schema: {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      async handler(args, ctx) {
        return truncate(await fs.readFile(resolveInWorkspace(ctx.workspaceRoot, str(args, 'path')), 'utf8'), maxOut);
      },
    },
    {
      risk: 'read',
      schema: {
        name: 'list_dir',
        description: 'List entries of a workspace directory (directories end with /).',
        parameters: { type: 'object', properties: { path: { type: 'string', default: '.' } } },
      },
      async handler(args, ctx) {
        const dir = resolveInWorkspace(ctx.workspaceRoot, str(args, 'path', false) || '.');
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
      },
    },
    {
      risk: 'read',
      schema: {
        name: 'search_text',
        description: 'Search workspace files for a regular expression. Returns path:line: text matches.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, path: { type: 'string', default: '.' } },
          required: ['pattern'],
        },
      },
      async handler(args, ctx) {
        const re = new RegExp(str(args, 'pattern'), 'i');
        const start = resolveInWorkspace(ctx.workspaceRoot, str(args, 'path', false) || '.');
        const hits: string[] = [];
        const skip = new Set(['node_modules', '.git', 'dist', '.coderelay']);
        async function walk(dir: string): Promise<void> {
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            if (hits.length >= 200) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (!skip.has(e.name)) await walk(full);
            } else if (e.isFile()) {
              const stat = await fs.stat(full);
              if (stat.size > 1_000_000) continue;
              const lines = (await fs.readFile(full, 'utf8')).split('\n');
              lines.forEach((line, i) => {
                if (hits.length < 200 && re.test(line)) hits.push(`${path.relative(ctx.workspaceRoot, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
              });
            }
          }
        }
        await walk(start);
        return hits.join('\n') || 'No matches.';
      },
    },
  ];

  if (opts.allowWrites !== false) {
    tools.push({
      risk: 'write',
      schema: {
        name: 'write_file',
        description: 'Create or overwrite a UTF-8 text file in the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      async handler(args, ctx) {
        const file = resolveInWorkspace(ctx.workspaceRoot, str(args, 'path'));
        await fs.mkdir(path.dirname(file), { recursive: true });
        const content = str(args, 'content');
        await fs.writeFile(file, content, 'utf8');
        return `Wrote ${content.length} chars to ${path.relative(ctx.workspaceRoot, file)}`;
      },
    });
  }

  if (opts.allowCommands) {
    tools.push({
      risk: 'exec',
      schema: {
        name: 'run_command',
        description: 'Run a shell command in the workspace and return exit code, stdout and stderr.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      handler(args, ctx) {
        const command = str(args, 'command');
        return new Promise((resolve) => {
          const child = spawn(command, { cwd: ctx.workspaceRoot, shell: true, signal: ctx.signal, windowsHide: true });
          let out = '';
          let err = '';
          const timer = setTimeout(() => child.kill(), opts.commandTimeoutMs ?? 120_000);
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('error', (e) => {
            clearTimeout(timer);
            resolve(`error: ${e.message}`);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve(truncate(`exit ${code}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`, maxOut));
          });
        });
      },
    });
  }

  return tools;
}
