import { z } from 'zod';

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: z.object({ stocks: z.array(z.unknown()) }).passthrough(),
  predictions: z.union([z.array(z.unknown()), z.object({ markets: z.array(z.unknown()) }).passthrough()]),
  telegram: z.object({}).passthrough().refine(
    (obj) => 'items' in obj || 'messages' in obj,
    { message: 'Must have items or messages' },
  ),
  intelligence: z.object({}).passthrough(),
  conflict: z.object({ events: z.array(z.unknown()) }).passthrough(),
  ais: z.object({}).passthrough(),
  giving: z.object({}).passthrough(),
  climate: z.union([z.array(z.unknown()), z.object({ anomalies: z.array(z.unknown()) }).passthrough()]),
  fred: z.union([z.array(z.unknown()), z.object({ series: z.array(z.unknown()) }).passthrough()]),
  oil: z.union([z.array(z.unknown()), z.object({ prices: z.array(z.unknown()) }).passthrough()]),
  'ai:panel-summary': z.object({}).passthrough(),
  'ai:risk-overview': z.object({}).passthrough(),
  'ai:posture-analysis': z.object({}).passthrough(),
  gdelt: z.object({}).passthrough(),
  cyber: z.union([z.array(z.unknown()), z.object({ threats: z.array(z.unknown()) }).passthrough()]),
};
