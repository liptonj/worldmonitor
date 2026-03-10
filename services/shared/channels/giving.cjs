'use strict';

// Fetches data from charitable giving/donations summary APIs
module.exports = async function fetchGiving({ config, redis, log, http }) {
  const now = new Date().toISOString();
  log.info('giving: returning empty summary (not yet implemented)');
  return {
    timestamp: now,
    source: 'giving',
    status: 'success',
    data: {
      // Keep proto-compatible shape so frontend protoToGivingSummary can consume relay pushes.
      summary: {
        generatedAt: now,
        activityIndex: 0,
        trend: 'stable',
        estimatedDailyFlowUsd: 0,
        platforms: [],
        categories: [],
        crypto: {
          dailyInflowUsd: 0,
          trackedWallets: 0,
          transactions24h: 0,
          topReceivers: [],
          pctOfTotal: 0,
        },
        institutional: {
          oecdOdaAnnualUsdBn: 0,
          oecdDataYear: 0,
          cafWorldGivingIndex: 0,
          cafDataYear: 0,
          candidGrantsTracked: 0,
          dataLag: 'Unknown',
        },
      },
    },
  };
};
