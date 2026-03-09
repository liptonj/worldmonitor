'use strict';

// AI generator: Military/strategic posture analysis
// Fetches strategic-posture, conflict, military data from Redis, calls LLM to analyze postures.
// Frontend: StrategicPosturePanel.applyAiAnalysis(payload) — expects { analyses: [...] } or worker format.
// Relay broadcasts full { timestamp, source, data, status }; data.analyses is the array.

const { fetchLLMProvider, callLLM } = require('@worldmonitor/shared/llm.cjs');

const REDIS_KEYS = ['relay:strategic-posture:v1', 'relay:conflict:v1', 'relay:opensky:v1'];

module.exports = async function generatePostureAnalysis({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generatePostureAnalysis executing');

  try {
    const [postureData, conflictData, openskyData] = await Promise.all(
      REDIS_KEYS.map((k) => redis.get(k))
    );

    const theaters = postureData?.theaters ?? postureData?.postures ?? postureData?.data ?? [];
    const theaterArr = Array.isArray(theaters) ? theaters.slice(0, 15) : [];
    const conflictItems = conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];
    const flights = openskyData?.flights ?? openskyData?.data ?? [];
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

    const provider = await fetchLLMProvider(supabase);

    const systemPrompt =
      'You are a military intelligence analyst. Analyze military and strategic postures from the data. Identify key actors, their capabilities, intentions, and force deployments. Output valid JSON: { "analyses": [{ "actor", "posture", "capabilities", "intentions", "locations" }] }.';

    const userPrompt = `Analyze military postures:\n\n${JSON.stringify(context, null, 2)}`;

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http, {
  temperature: 0.4,
  maxTokens: 2500,
});

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generatePostureAnalysis malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
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
