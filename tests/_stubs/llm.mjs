// Stub for server/_shared/llm.ts used in country intel caching tests.
// Returns a mock provider so the fetcher runs and we can test cache key behavior.

export async function getActiveLlmProvider() {
  return {
    name: 'groq',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    apiKey: process.env.GROQ_API_KEY || 'test-key',
  };
}

export async function getLlmPrompt() {
  return {
    systemPrompt: 'You are an analyst.',
    userPrompt: 'Brief for {{countryName}} ({{countryCode}}). Context snapshot: {{contextSnapshot}}. Headlines: {{recentHeadlines}}',
  };
}

export function buildPrompt(template, vars = {}) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v ?? ''));
  }
  // When contextSnapshot is blank, omit the context block (matches real behavior)
  if (!vars.contextSnapshot || String(vars.contextSnapshot).trim() === '') {
    out = out.replace(/Context snapshot:\s*/g, '');
  }
  return out;
}
