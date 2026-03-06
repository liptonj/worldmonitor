// src/services/feature-flag-client.ts
import type { MlFeatureFlags, MlThresholds } from '@/config/ml-config';
import { getHydratedFeatureFlags } from '@/services/bootstrap';

let _flags: Record<string, unknown> | null = null;

export function loadFeatureFlags(): void {
  const hydrated = getHydratedFeatureFlags();
  if (hydrated) _flags = hydrated;
  // No HTTP fetch — relay pushes config:feature-flags via WS; applyFeatureFlags handles updates
}

function flag<T>(key: string): T | undefined {
  if (!_flags) return undefined;
  const val = _flags[key];
  if (val === undefined) return undefined;
  return (typeof val === 'string' ? JSON.parse(val) : val) as T;
}

export function getMLFeatureFlags(): MlFeatureFlags {
  return {
    semanticClustering: flag<boolean>('ml.semanticClustering') ?? false,
    mlSentiment: flag<boolean>('ml.mlSentiment') ?? false,
    summarization: flag<boolean>('ml.summarization') ?? false,
    mlNER: flag<boolean>('ml.mlNER') ?? false,
    insightsPanel: flag<boolean>('ml.insightsPanel') ?? false,
  };
}

export function getMLThresholds(): MlThresholds {
  return {
    semanticClusterThreshold: flag<number>('ml.semanticClusterThreshold') ?? 0.75,
    minClustersForML: flag<number>('ml.minClustersForML') ?? 5,
    maxTextsPerBatch: flag<number>('ml.maxTextsPerBatch') ?? 20,
    modelLoadTimeoutMs: flag<number>('ml.modelLoadTimeoutMs') ?? 60_000,
    inferenceTimeoutMs: flag<number>('ml.inferenceTimeoutMs') ?? 120_000,
    memoryBudgetMB: flag<number>('ml.memoryBudgetMB') ?? 200,
  };
}

export function isFeatureEnabled(key: string): boolean {
  return flag<boolean>(key) ?? false;
}

export function areFlagsLoaded(): boolean {
  return _flags !== null;
}

/** Called when relay pushes a fresh config:feature-flags payload via WS. */
export function applyFeatureFlags(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  _flags = payload as Record<string, unknown>;
}
