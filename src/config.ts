import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from './agents/agent.js';
import { defaultAgents } from './agents/defaults.js';
import { createWorkspaceTools } from './agents/tools.js';
import type { Budget } from './metrics/cost.js';
import { PricingTable, type ModelPrice } from './metrics/pricing.js';
import type { RiskPolicy } from './metrics/risk.js';
import { Orchestrator, type OrchestratorOptions } from './orchestrator/orchestrator.js';
import { MockProvider } from './providers/mock.js';
import { githubModelsProvider, OpenAICompatibleProvider } from './providers/openai-compatible.js';
import type { LLMProvider } from './providers/provider.js';
import { FileSessionStore } from './session/store.js';

export interface ProviderConfig {
  type: 'github-models' | 'openai-compatible' | 'mock';
  baseUrl?: string;
  /** Env var holding the API key/token (default GITHUB_TOKEN for github-models). */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export interface CodeRelayConfig {
  provider?: ProviderConfig;
  model?: string;
  orchestratorModel?: string;
  /** Where sessions are stored. Default `.coderelay/sessions`. */
  sessionDir?: string;
  workspace?: string;
  maxConcurrency?: number;
  taskRetries?: number;
  taskTimeoutMs?: number;
  budget?: Budget;
  pricing?: Record<string, ModelPrice>;
  premiumRequestUsd?: number;
  risk?: Omit<RiskPolicy, 'onReview' | 'rules'> & { onReview?: 'allow' | 'block' };
  tools?: { allowCommands?: boolean; allowWrites?: boolean; commandTimeoutMs?: number };
  /** Agents merged over the defaults by name (set `replaceDefaultAgents` to use only these). */
  agents?: AgentDefinition[];
  replaceDefaultAgents?: boolean;
  compaction?: { maxContextTokens?: number; keepRecent?: number } | false;
  synthesize?: boolean;
}

export const CONFIG_FILE = 'coderelay.config.json';

export function loadConfig(file?: string, cwd = process.cwd()): CodeRelayConfig & { configPath?: string } {
  const p = path.resolve(cwd, file ?? CONFIG_FILE);
  if (!existsSync(p)) {
    if (file) throw new Error(`Config not found: ${p}`);
    return {};
  }
  return { ...(JSON.parse(readFileSync(p, 'utf8')) as CodeRelayConfig), configPath: p };
}

export function createProvider(config: ProviderConfig | undefined): LLMProvider {
  const type = config?.type ?? (process.env.GITHUB_TOKEN ? 'github-models' : 'mock');
  switch (type) {
    case 'mock':
      return new MockProvider();
    case 'github-models':
      return githubModelsProvider({
        token: config?.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined,
        baseUrl: config?.baseUrl,
      });
    case 'openai-compatible':
      if (!config?.baseUrl) throw new Error('provider.baseUrl is required for openai-compatible');
      return new OpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined,
        headers: config.headers,
      });
    default:
      throw new Error(`Unknown provider type: ${String(type)}`);
  }
}

export function mergeAgents(config: CodeRelayConfig): AgentDefinition[] {
  if (config.replaceDefaultAgents) return config.agents ?? [];
  const byName = new Map(defaultAgents.map((a) => [a.name, a]));
  for (const a of config.agents ?? []) byName.set(a.name, { ...byName.get(a.name), ...a });
  return [...byName.values()];
}

/** Build a fully wired Orchestrator from a config object. */
export function createOrchestrator(config: CodeRelayConfig, overrides: Partial<OrchestratorOptions> = {}): Orchestrator {
  const workspace = path.resolve(config.workspace ?? process.cwd());
  return new Orchestrator({
    provider: createProvider(config.provider),
    model: config.model ?? 'openai/gpt-4.1',
    orchestratorModel: config.orchestratorModel,
    agents: mergeAgents(config),
    tools: createWorkspaceTools(config.tools),
    store: new FileSessionStore(path.resolve(workspace, config.sessionDir ?? path.join('.coderelay', 'sessions'))),
    pricing: new PricingTable(config.pricing ?? {}, { premiumRequestUsd: config.premiumRequestUsd }),
    budget: config.budget,
    risk: { ...config.risk, workspaceRoot: workspace },
    maxConcurrency: config.maxConcurrency,
    taskRetries: config.taskRetries,
    taskTimeoutMs: config.taskTimeoutMs,
    workspaceRoot: workspace,
    compaction: config.compaction,
    synthesize: config.synthesize,
    ...overrides,
  });
}

export const exampleConfig: CodeRelayConfig = {
  provider: { type: 'github-models', apiKeyEnv: 'GITHUB_TOKEN' },
  model: 'openai/gpt-4.1',
  orchestratorModel: 'openai/gpt-4.1-mini',
  maxConcurrency: 4,
  taskRetries: 1,
  budget: { maxCostUsd: 5, maxPremiumRequests: 150, warnAt: 0.8 },
  pricing: {
    'openai/gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
    'openai/gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  },
  risk: { reviewThreshold: 50, blockThreshold: 80, onReview: 'allow' },
  tools: { allowCommands: false, allowWrites: true },
  compaction: { maxContextTokens: 24000, keepRecent: 12 },
};
