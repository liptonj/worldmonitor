'use strict';

// Extracted from scripts/ais-relay.cjs - USAspending.gov federal contract awards

const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const TIMEOUT_MS = 20_000;

const AWARD_TYPE_MAP = {
  A: 'contract',
  B: 'contract',
  C: 'contract',
  D: 'contract',
  '02': 'grant',
  '03': 'grant',
  '04': 'grant',
  '05': 'grant',
  '06': 'grant',
  '10': 'grant',
  '07': 'loan',
  '08': 'loan',
};

module.exports = async function fetchSpending({ config, redis, log, http }) {
  log.debug('fetchSpending executing');
  const timestamp = new Date().toISOString();

  try {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 7);
    const periodEnd = new Date();
    const startStr = periodStart.toISOString().slice(0, 10);
    const endStr = periodEnd.toISOString().slice(0, 10);

    const body = JSON.stringify({
      filters: {
        time_period: [{ start_date: startStr, end_date: endStr }],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Description', 'Start Date', 'Award Type'],
      limit: 15,
      order: 'desc',
      sort: 'Award Amount',
    });

    const data = await http.fetchJson(USASPENDING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
      body,
    });

    const results = data?.results;
    const raw = Array.isArray(results) ? results : [];
    const awards = raw.map((r) => ({
      id: String(r['Award ID'] ?? ''),
      recipientName: String(r['Recipient Name'] ?? 'Unknown'),
      amount: Number(r['Award Amount']) || 0,
      agency: String(r['Awarding Agency'] ?? 'Unknown'),
      description: String(r['Description'] ?? '').slice(0, 200),
      startDate: String(r['Start Date'] ?? ''),
      awardType: AWARD_TYPE_MAP[String(r['Award Type'] ?? '')] || 'other',
    }));

    const dataArray = Array.isArray(awards) ? awards : [];
    return {
      timestamp,
      source: 'spending',
      data: dataArray,
      status: 'success',
      periodStart: startStr,
      periodEnd: endStr,
    };
  } catch (err) {
    log.error('fetchSpending error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'spending',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
