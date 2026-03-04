import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getRiskScores } from './get-risk-scores';
import { getPizzintStatus } from './get-pizzint-status';
import { classifyEvent } from './classify-event';
import { getCountryIntelBrief } from './get-country-intel-brief';
import { searchGdeltDocuments } from './search-gdelt-documents';
import { deductSituation } from './deduct-situation';
import { getGlobalIntelDigest } from './get-global-intel-digest';
import { summarizeView } from './summarize-view';

export const intelligenceHandler = {
  getRiskScores,
  getPizzintStatus,
  classifyEvent,
  getCountryIntelBrief,
  searchGdeltDocuments,
  deductSituation,
  getGlobalIntelDigest,
  summarizeView,
} as IntelligenceServiceHandler;
