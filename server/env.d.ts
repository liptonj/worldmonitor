/** Ambient declaration for process.env — shared by all server-side modules. */
declare const process: {
  env: Record<string, string | undefined> & {
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
  };
};
