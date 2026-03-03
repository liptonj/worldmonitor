// src/config/ml-config.ts
// Types only — runtime values come from /api/config/feature-flags

export interface ModelConfig {
  id: string;
  name: string;
  hfModel: string;
  size: number;
  priority: number;
  required: boolean;
  task: 'feature-extraction' | 'text-classification' | 'text2text-generation' | 'token-classification';
}

export interface MlFeatureFlags {
  semanticClustering: boolean;
  mlSentiment: boolean;
  summarization: boolean;
  mlNER: boolean;
  insightsPanel: boolean;
}

export interface MlThresholds {
  semanticClusterThreshold: number;
  minClustersForML: number;
  maxTextsPerBatch: number;
  modelLoadTimeoutMs: number;
  inferenceTimeoutMs: number;
  memoryBudgetMB: number;
}
