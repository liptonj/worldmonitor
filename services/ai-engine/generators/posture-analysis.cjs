'use strict';

// AI generator: Military/strategic posture analysis
// Fetches strategic-posture, conflict, military data from Redis, calls LLM to analyze postures.
// Supports incremental: skips LLM when inputs unchanged.

const { callLLMForFunction, extractJson } = require('@worldmonitor/shared/llm.cjs');

const FALLBACK_SYSTEM_PROMPT =
  'You MUST respond with ONLY valid JSON, no prose, no markdown fences, no explanation. Use this exact structure: { "analyses": [{ "actor", "posture", "capabilities", "intentions", "locations" }] }.';

const REDIS_KEYS = ['theater-posture:sebuf:v1', 'relay:conflict:v1', 'relay:ais-snapshot:v1'];

module.exports = async function generatePostureAnalysis({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generatePostureAnalysis executing');

  try {
    const previousKeys = REDIS_KEYS.map((k) => `${k}:previous`);
    const [previousOutput, ...currentResults] = await Promise.all([
      redis.get('ai:posture-analysis:v1'),
      ...REDIS_KEYS.map((k) => redis.get(k)),
      ...previousKeys.map((k) => redis.get(k)),
    ]);
    const currentData = currentResults.slice(0, REDIS_KEYS.length);
    const previousData = currentResults.slice(REDIS_KEYS.length);

    const contextStr = JSON.stringify(currentData);
    const previousContextStr = JSON.stringify(previousData);
    const inputsUnchanged = contextStr === previousContextStr;
    const previousAnalyses =
      previousOutput?.source === 'ai:posture-analysis' && previousOutput?.status === 'success'
        ? (previousOutput?.data?.analyses ?? previousOutput?.analyses ?? [])
        : [];
    const hasPreviousAnalyses = Array.isArray(previousAnalyses) && previousAnalyses.length > 0;

    if (inputsUnchanged && hasPreviousAnalyses) {
      log.info('Posture analysis inputs unchanged, keeping previous output');
      return previousOutput;
    }

    const [postureData, conflictData, openskyData] = currentData;

    const theaters = postureData?.theaters ?? postureData?.postures ?? postureData?.data ?? [];
    const theaterArr = Array.isArray(theaters) ? theaters.slice(0, 15) : [];
    const conflictItems = conflictData?.data?.events ?? conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];
    const flights = openskyData?.vessels ?? openskyData?.flights ?? openskyData?.data ?? [];
    const flightArr = Array.isArray(flights) ? flights.slice(0, 30) : [];

    const context = {
      theaters: theaterArr.map((t) => ({ name: t.name ?? t.theaterName, level: t.postureLevel ?? t.level, aircraft: t.totalAircraft ?? t.aircraft, vessels: t.totalVessels ?? t.vessels })),
      conflict: conflictArr.map((c) => ({ country: c.country ?? c.actor1, event: c.event_type, location: c.location })),
      flights: flightArr.map((f) => ({ origin: f.origin_country, dest: f.destination_country ?? f.country, type: f.icao24 ?? f.callsign })),
    };

    if (theaterArr.length === 0 && conflictArr.length === 0) {
      log.warn('No posture or conflict data for analysis');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:posture-analysis',
        data: { analyses: [] },
        status: 'success',
      };
    }

    const theaterData = JSON.stringify(context, null, 2);
    const placeholders = {
      date: new Date().toISOString().slice(0, 10),
      theaterData,
    };

    const result = await callLLMForFunction(
      supabase,
      'posture_analysis',
      'strategic_posture_analysis',
      placeholders,
      http,
      {
        temperature: 0.4,
        maxTokens: 2500,
        jsonMode: false,
        fallbackSystemPrompt: FALLBACK_SYSTEM_PROMPT,
        fallbackUserPrompt: hasPreviousAnalyses
          ? `Here is the previous posture analysis:\n${JSON.stringify(previousAnalyses, null, 2)}\n\nHere is the updated data. Update the analysis to reflect any changes:\n${theaterData}`
          : `Analyze military postures:\n\n${theaterData}`,
      },
    );

    let parsed;
    if (result.parsed) {
      parsed = result.parsed;
    } else {
      try {
        parsed = extractJson(result.content);
      } catch (parseErr) {
        log.error('generatePostureAnalysis malformed LLM JSON', { error: parseErr.message });
        throw new Error('LLM returned invalid JSON');
      }
    }

    const analyses = Array.isArray(parsed.analyses) ? parsed.analyses : [];

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:posture-analysis',
      data: { analyses },
      status: 'success',
    };
  } catch (err) {
    log.error('generatePostureAnalysis error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:posture-analysis',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
