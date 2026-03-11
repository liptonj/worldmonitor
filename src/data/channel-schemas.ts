import { z } from 'zod';

const looseObject = z.record(z.string(), z.unknown());

export const channelSchemas: Record<string, z.ZodSchema> = {
  markets: looseObject,
  predictions: z.union([z.array(z.unknown()), looseObject]),
  telegram: z.union([
    z.array(z.unknown()),
    looseObject.refine((obj) => {
      return Array.isArray(obj.items)
        || Array.isArray(obj.messages)
        || (obj.data && typeof obj.data === 'object'
          && (Array.isArray((obj.data as Record<string, unknown>).items)
            || Array.isArray((obj.data as Record<string, unknown>).messages)));
    }, { message: 'Must have items/messages array at root or in data' }),
  ]),
  intelligence: looseObject,
  conflict: looseObject.refine(
    (obj) => Array.isArray(obj.events),
    { message: 'Must have events array' },
  ),
  ais: looseObject,
  giving: looseObject,
  climate: z.union([z.array(z.unknown()), looseObject]),
  fred: z.union([z.array(z.unknown()), looseObject]),
  oil: z.union([z.array(z.unknown()), looseObject]),
  'ai:intel-digest': looseObject,
  'ai:panel-summary': looseObject,
  'ai:risk-overview': looseObject,
  'ai:posture-analysis': looseObject,
  gdelt: looseObject,
  cyber: z.union([z.array(z.unknown()), looseObject]),
  'security-advisories': z.union([z.array(z.unknown()), looseObject]),
};
