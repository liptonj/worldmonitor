import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { renderLoginPage } from './admin/login';
import { renderDashboard } from './admin/dashboard';

const supabase: SupabaseClient = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { auth: { persistSession: true } },
);

const app = document.getElementById('app')!;

async function init(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    renderLoginPage(app, supabase, onSignIn);
    return;
  }
  await onSignIn(session.user, session.access_token);
}

async function onSignIn(user: User, accessToken: string): Promise<void> {
  const res = await fetch('/api/admin/feature-flags', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401 || res.status === 403) {
    app.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">
      <h2>Access Denied</h2><p>This account does not have admin access.</p>
      <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;cursor:pointer">Sign Out</button>
    </div>`;
    await supabase.auth.signOut();
    return;
  }

  renderDashboard(app, supabase, accessToken, user);
}

init().catch(console.error);
