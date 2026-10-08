import type { AgentDefinition } from './agent.js';

const RULES =
  'Work inside the workspace only. Prefer small, verifiable steps. Never print secrets. ' +
  'If a tool call is BLOCKED by the risk policy, do not retry it; pick a safer approach or explain what a human must do. ' +
  'Finish with a concise summary of what you did and anything left open.';

/** A sensible starting team. Override or extend via config. */
export const defaultAgents: AgentDefinition[] = [
  {
    name: 'architect',
    description: 'Designs solutions, breaks down requirements, chooses structure and interfaces.',
    systemPrompt: `You are a senior software architect. Read the relevant code, then produce a concrete design: components, files, interfaces, risks. ${RULES}`,
    capabilities: ['design', 'architecture', 'plan', 'requirements', 'api', 'schema'],
    tools: ['read_file', 'list_dir', 'search_text'],
    maxTurns: 10,
  },
  {
    name: 'coder',
    description: 'Implements features, fixes bugs and refactors code.',
    systemPrompt: `You are an expert software engineer. Implement the task by editing files with the tools available. Match the existing code style. ${RULES}`,
    capabilities: ['implement', 'code', 'fix', 'bug', 'refactor', 'feature', 'typescript', 'javascript', 'python'],
    tools: ['*'],
    maxTurns: 16,
  },
  {
    name: 'tester',
    description: 'Writes and runs tests, reproduces bugs, verifies behaviour.',
    systemPrompt: `You are a meticulous test engineer. Write focused tests for the behaviour described and run them when you can. ${RULES}`,
    capabilities: ['test', 'tests', 'verify', 'qa', 'coverage', 'reproduce'],
    tools: ['*'],
    maxTurns: 12,
  },
  {
    name: 'reviewer',
    description: 'Reviews changes for correctness, security and maintainability.',
    systemPrompt: `You are a rigorous code reviewer. Inspect the changes and report concrete issues ordered by severity, with file references. ${RULES}`,
    capabilities: ['review', 'security', 'audit', 'quality', 'lint'],
    tools: ['read_file', 'list_dir', 'search_text'],
    maxTurns: 10,
  },
  {
    name: 'researcher',
    description: 'Explores the codebase and documentation to answer questions and gather context.',
    systemPrompt: `You are a codebase researcher. Find and explain the relevant code and facts precisely, citing files. ${RULES}`,
    capabilities: ['research', 'explore', 'explain', 'docs', 'documentation', 'investigate'],
    tools: ['read_file', 'list_dir', 'search_text'],
    maxTurns: 10,
  },
  {
    name: 'generalist',
    description: 'Handles any task that does not fit a specialist.',
    systemPrompt: `You are a capable software engineering assistant. ${RULES}`,
    capabilities: ['general'],
    tools: ['*'],
  },
];
