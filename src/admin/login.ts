import type { SupabaseClient, User } from '@supabase/supabase-js';

export function renderLoginPage(
  container: HTMLElement,
  supabase: SupabaseClient,
  onSuccess: (user: User, token: string) => void,
): void {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:40px;width:360px">
        <h1 style="font-size:20px;margin-bottom:4px">World Monitor</h1>
        <p style="color:var(--text-muted);margin-bottom:24px">Admin Portal</p>

        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Email</label>
        <input id="admin-email" type="email" autocomplete="email" style="
          width:100%;padding:8px 12px;margin-bottom:16px;
          background:var(--bg);border:1px solid var(--border);
          border-radius:var(--radius);color:var(--text);font-size:14px;
        "/>

        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Password</label>
        <input id="admin-password" type="password" autocomplete="current-password" style="
          width:100%;padding:8px 12px;margin-bottom:24px;
          background:var(--bg);border:1px solid var(--border);
          border-radius:var(--radius);color:var(--text);font-size:14px;
        "/>

        <button id="admin-login-btn" style="
          width:100%;padding:10px;background:var(--accent);color:#fff;
          border:none;border-radius:var(--radius);cursor:pointer;font-size:14px;font-weight:600;
        ">Sign In</button>
        <p id="admin-login-error" style="color:var(--danger);margin-top:12px;display:none"></p>
      </div>
    </div>
  `;

  const btn = container.querySelector<HTMLButtonElement>('#admin-login-btn')!;
  const errEl = container.querySelector<HTMLParagraphElement>('#admin-login-error')!;

  async function attempt(): Promise<void> {
    const email = (container.querySelector<HTMLInputElement>('#admin-email')!).value.trim();
    const password = (container.querySelector<HTMLInputElement>('#admin-password')!).value;
    if (!email || !password) { errEl.textContent = 'Email and password required.'; errEl.style.display = 'block'; return; }

    btn.disabled = true; btn.textContent = 'Signing in…'; errEl.style.display = 'none';
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      btn.disabled = false; btn.textContent = 'Sign In';
      errEl.textContent = 'Invalid email or password.'; errEl.style.display = 'block';
      return;
    }
    onSuccess(data.user, data.session.access_token);
  }

  btn.addEventListener('click', attempt);
  container.querySelector<HTMLInputElement>('#admin-password')!
    .addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
}
