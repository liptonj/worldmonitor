'use strict';

// AI generator: Global intelligence digest
// Aggregates news, conflict, cyber data from Redis, calls LLM, returns structured analysis

const { fetchLLMProvider, callLLM } = require('@worldmonitor/shared/llm.cjs');

module.exports = async function generateIntelDigest({ supabase, redis, log, http }) {
  log.debug('generateIntelDigest executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const [newsData, conflictData, cyberData] = await Promise.all([
      redis.get('news:digest:v1:full:en'),
      redis.get('relay:conflict:v1'),
      redis.get('relay:cyber:v1'),
    ]);

    const context = {
      news: newsData?.data ?? newsData?.items ?? [],
      conflict: conflictData?.data ?? conflictData?.items ?? [],
      cyber: cyberData?.data ?? cyberData?.items ?? [],
    };

    // TODO: Load prompt from wm_admin.llm_prompts via get_llm_prompt RPC
    // Falling back to this hardcoded prompt if none is found
    const systemPrompt =
      'You are an intelligence analyst. Synthesize the following data sources into a concise global intelligence digest. Focus on significant developments, emerging patterns, and potential risks. Output valid JSON with fields: summary (string), highlights (array of strings), regions (array of strings).';

    const userPrompt = `Analyze this data and create an intelligence digest:\n\n${JSON.stringify(context, null, 2)}`;

    const provider = await fetchLLMProvider(supabase);
    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    const parsed = JSON.parse(responseText);
    const summary = parsed.summary ?? '';
    const highlights = Array.isArray(parsed.highlights) ? parsed.highlights : [];
    const regions = Array.isArray(parsed.regions) ? parsed.regions : [];

    const digest = [
      summary,
      highlights.length ? `\n\n## Highlights\n${highlights.map((h) => `- ${h}`).join('\n')}` : '',
      regions.length ? `\n\n## Regions\n${regions.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('');

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:intel-digest',
      data: {
        digest,
        summary,
        highlights,
        regions,
        model: provider.model_name,
        provider: provider.provider_type || 'openai',
        generatedAt: new Date().toISOString(),
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generateIntelDigest error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:intel-digest',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
