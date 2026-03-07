'use strict';

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];

function loadConfig() {
  for (const key of required) {
    const val = process.env[key];
    if (val == null || val === '') {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  const config = Object.freeze({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    WORKER_GRPC_PORT: parseInt(process.env.WORKER_GRPC_PORT || '50052', 10),
    GATEWAY_GRPC_PORT: parseInt(process.env.GATEWAY_GRPC_PORT || '50051', 10),
    AI_ENGINE_GRPC_PORT: parseInt(process.env.AI_ENGINE_GRPC_PORT || '50053', 10),
    GATEWAY_HOST: process.env.GATEWAY_HOST || 'gateway',
    WORKER_HOST: process.env.WORKER_HOST || 'worker',
    AI_ENGINE_HOST: process.env.AI_ENGINE_HOST || 'ai-engine',
    NODE_ENV: process.env.NODE_ENV || 'development',
  });

  return config;
}

const config = loadConfig();
module.exports = config;
