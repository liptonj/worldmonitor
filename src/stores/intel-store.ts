import type { CyberThreat } from '@/types';
import type { IntelligenceCache } from '@/app/app-context';

export const intelStore = {
  intelligenceCache: {} as IntelligenceCache,
  cyberThreatsCache: null as CyberThreat[] | null,
};
