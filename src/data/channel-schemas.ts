import { z } from 'zod';

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: z.object({}).passthrough(),
  predictions: z.union([z.array(z.unknown()), z.object({ markets: z.array(z.unknown()) }).passthrough()]),
  telegram: z.union([
    z.array(z.unknown()),
    z.object({}).passthrough().refine((obj) => {
      if (Array.isArray((obj as Record<string, unknown>).items) || Array.isArray((obj as Record<string, unknown>).messages)) {
        return true;
      }
      const nested = (obj as Record<string, unknown>).data;
      return !!nested
        && typeof nested === 'object'
        && (Array.isArray((nested as Record<string, unknown>).items)
          || Array.isArray((nested as Record<string, unknown>).messages));
    }, { message: 'Must have items/messages array at root or in data' }),
  ]),
  intelligence: z.object({}).passthrough(),
  conflict: z.object({ events: z.array(z.unknown()) }).passthrough(),
  ais: z.object({}).passthrough(),
  giving: z.object({}).passthrough(),
  climate: z.union([z.array(z.unknown()), z.object({ anomalies: z.array(z.unknown()) }).passthrough()]),
  fred: z.union([z.array(z.unknown()), z.object({ series: z.array(z.unknown()) }).passthrough()]),
  oil: z.union([z.array(z.unknown()), z.object({ prices: z.array(z.unknown()) }).passthrough()]),
  'ai:intel-digest': z.object({}).passthrough(),
  'ai:panel-summary': z.object({}).passthrough(),
  'ai:risk-overview': z.object({}).passthrough(),
  'ai:posture-analysis': z.object({}).passthrough(),
  gdelt: z.object({}).passthrough(),
  cyber: z.union([z.array(z.unknown()), z.object({ threats: z.array(z.unknown()) }).passthrough()]),
  'security-advisories': z.union([z.array(z.unknown()), z.object({ items: z.array(z.unknown()) }).passthrough()]),
};
