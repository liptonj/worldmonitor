// Stub for server/_shared/secrets.ts used in unit tests.
// Falls back to process.env so tests that set env vars still work.
export async function getSecret(name) {
  return process.env[name] ?? null;
}
