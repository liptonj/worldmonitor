type CategoryId = 'stock' | 'commodity' | 'crypto' | 'sector';

interface SymbolEntry {
  symbol: string;
  name: string;
  display: string | null;
  sort_order: number;
}

interface MarketSymbolsData {
  stock: SymbolEntry[];
  commodity: SymbolEntry[];
  crypto: SymbolEntry[];
  sector: SymbolEntry[];
}

const CATEGORIES: Array<{ id: CategoryId; label: string; max: number }> = [
  { id: 'stock', label: 'Stocks / Indices', max: 30 },
  { id: 'commodity', label: 'Commodities', max: 10 },
  { id: 'crypto', label: 'Crypto', max: 10 },
  { id: 'sector', label: 'Sector ETFs', max: 15 },
];

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarketSymbolsPage(container: HTMLElement, token: string): void {
  let state: MarketSymbolsData = {
    stock: [],
    commodity: [],
    crypto: [],
    sector: [],
  };

  let activeCategory: CategoryId = 'stock';
  let validatedSymbol: { symbol: string; name: string; display: string } | null = null;

  container.innerHTML = `
    <h2 style="margin-bottom:24px">Market Symbols</h2>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:24px">
      Manage market symbols for stocks, commodities, crypto, and sector ETFs. Drag to reorder.
    </p>
    <div id="market-symbols-body">Loading…</div>
  `;

  function render(): void {
    const body = container.querySelector<HTMLElement>('#market-symbols-body')!;
    const cat = CATEGORIES.find((c) => c.id === activeCategory)!;
    const symbols = state[activeCategory] ?? [];

    const tabStyle =
      'display:inline-flex;align-items:center;gap:6px;padding:8px 14px;margin-right:4px;border-radius:var(--radius);cursor:pointer;border:1px solid transparent;font-size:13px;background:transparent;color:var(--text-muted)';
    const tabActiveStyle =
      'background:rgba(56,139,253,0.15);color:var(--accent);border-color:var(--accent)';
    const badgeStyle =
      'display:inline-block;padding:1px 6px;border-radius:10px;background:var(--surface);border:1px solid var(--border);font-size:11px;margin-left:4px';

    const tabsHtml = CATEGORIES.map(
      (c) =>
        `<button type="button" data-tab="${c.id}" style="${tabStyle}${c.id === activeCategory ? ';' + tabActiveStyle : ''}">
          ${escHtml(c.label)}
          <span style="${badgeStyle}">${(state[c.id] ?? []).length}/${c.max}</span>
        </button>`
    ).join('');

    const listRows = symbols
      .map(
        (s, i) => `
        <div class="symbol-row" data-index="${i}" draggable="true"
          style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface);cursor:grab">
          <span class="drag-handle" style="cursor:grab;color:var(--text-muted);font-size:14px;user-select:none" title="Drag to reorder">⠿</span>
          <span style="font-weight:600;min-width:80px;font-family:monospace">${escHtml(s.display ?? s.symbol)}</span>
          <span style="flex:1;color:var(--text)">${escHtml(s.name)}</span>
          <button type="button" class="btn-remove" data-index="${i}" style="padding:2px 8px;background:transparent;border:1px solid var(--border);border-radius:var(--radius);color:var(--error);cursor:pointer;font-size:16px;line-height:1">×</button>
        </div>`
      )
      .join('');

    body.innerHTML = `
      <div style="margin-bottom:20px;display:flex;flex-wrap:wrap;gap:4px">
        ${tabsHtml}
      </div>
      <div id="symbol-list" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:20px">
        ${listRows || '<div style="padding:16px;color:var(--text-muted);font-size:13px">No symbols yet. Add one below.</div>'}
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:20px">
        <div style="font-weight:500;margin-bottom:12px">Add symbol <span style="color:var(--text-muted);font-weight:400;font-size:12px">(max ${cat.max})</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <input type="text" id="add-symbol-input" placeholder="${activeCategory === 'crypto' ? 'e.g. bitcoin, ethereum' : 'e.g. AAPL, ^GSPC'}"
            style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:14px;width:180px"/>
          <button type="button" id="btn-validate" style="padding:8px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);cursor:pointer;font-size:13px">Validate</button>
          <span id="validate-result" style="font-size:13px;min-height:20px"></span>
          <button type="button" id="btn-add" disabled style="padding:8px 14px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;opacity:0.6">Add</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <button type="button" id="btn-save" style="padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:14px">Save Changes</button>
        <span id="save-feedback" style="font-size:13px;color:var(--accent);min-height:20px"></span>
      </div>
      <div id="market-symbols-error" style="color:var(--error);font-size:13px;margin-top:12px;min-height:20px"></div>
    `;

    // Tab click handlers
    body.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCategory = (btn as HTMLElement).dataset['tab'] as CategoryId;
        validatedSymbol = null;
        render();
      });
    });

    attachListeners();
  }

  function attachListeners(): void {
    const body = container.querySelector<HTMLElement>('#market-symbols-body')!;
    const cat = CATEGORIES.find((c) => c.id === activeCategory)!;
    const symbols = state[activeCategory] ?? [];

    // Validate
    body.querySelector('#btn-validate')!.addEventListener('click', async () => {
      const input = body.querySelector<HTMLInputElement>('#add-symbol-input')!;
      const resultEl = body.querySelector<HTMLElement>('#validate-result')!;
      const addBtn = body.querySelector<HTMLButtonElement>('#btn-add')!;
      const symbol = input.value.trim();
      if (!symbol) {
        resultEl.innerHTML = '<span style="color:var(--error)">Enter a symbol</span>';
        validatedSymbol = null;
        addBtn.disabled = true;
        return;
      }
      resultEl.textContent = 'Validating…';
      resultEl.style.color = 'var(--text-muted)';
      try {
        const res = await fetch('/api/admin/validate-symbol', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ category: activeCategory, symbol }),
        });
        if (!res.ok) {
          let errMsg = `Validation failed (${res.status})`;
          try {
            const j = (await res.json()) as { error?: string };
            errMsg = j.error ?? errMsg;
          } catch {
            /* non-JSON response */
          }
          resultEl.innerHTML = `<span style="color:var(--error)">✗ ${escHtml(errMsg)}</span>`;
          validatedSymbol = null;
          addBtn.disabled = true;
          return;
        }
        const json = (await res.json()) as {
          valid?: boolean;
          name?: string;
          price?: number;
          symbol?: string;
          error?: string;
        };
        if (json.error) {
          resultEl.innerHTML = `<span style="color:var(--error)">✗ ${escHtml(json.error)}</span>`;
          validatedSymbol = null;
          addBtn.disabled = true;
          return;
        }
        if (json.valid && json.name) {
          const display =
            activeCategory === 'crypto' ? (json.symbol ?? symbol) : symbol;
          validatedSymbol = { symbol, name: json.name, display };
          const priceStr =
            json.price != null ? ` $${Number(json.price).toLocaleString()}` : '';
          resultEl.innerHTML = `<span style="color:var(--success,#38a169)">✓ ${escHtml(json.name)}${escHtml(priceStr)}</span>`;
          if (symbols.length >= cat.max) {
            addBtn.disabled = true;
            resultEl.innerHTML += ` <span style="color:var(--error)">(max ${cat.max} reached)</span>`;
          } else {
            addBtn.disabled = false;
          }
        } else {
          resultEl.innerHTML = '<span style="color:var(--error)">✗ Invalid symbol</span>';
          validatedSymbol = null;
          addBtn.disabled = true;
        }
      } catch (err) {
        resultEl.innerHTML = '<span style="color:var(--error)">Validation failed</span>';
        validatedSymbol = null;
        addBtn.disabled = true;
        console.error('[market-symbols] validate error:', err);
      }
    });

    // Add
    body.querySelector('#btn-add')!.addEventListener('click', () => {
      if (!validatedSymbol) return;
      const list = state[activeCategory] ?? [];
      if (list.length >= cat.max) {
        const errEl = body.querySelector<HTMLElement>('#market-symbols-error')!;
        errEl.textContent = `Maximum ${cat.max} symbols for this category.`;
        return;
      }
      list.push({
        symbol: validatedSymbol.symbol,
        name: validatedSymbol.name,
        display: validatedSymbol.display || validatedSymbol.symbol,
        sort_order: list.length,
      });
      state[activeCategory] = list;
      validatedSymbol = null;
      const input = body.querySelector<HTMLInputElement>('#add-symbol-input')!;
      input.value = '';
      const resultEl = body.querySelector<HTMLElement>('#validate-result')!;
      resultEl.textContent = '';
      render();
    });

    // Remove
    body.querySelectorAll('.btn-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt((e.currentTarget as HTMLElement).dataset['index']!, 10);
        const list = [...(state[activeCategory] ?? [])];
        list.splice(idx, 1);
        list.forEach((s, i) => (s.sort_order = i));
        state[activeCategory] = list;
        render();
      });
    });

    // Drag and drop
    const listEl = body.querySelector<HTMLElement>('#symbol-list');
    if (listEl) {
      const rows = listEl.querySelectorAll('.symbol-row');
      rows.forEach((row, i) => {
        row.addEventListener('dragstart', (e: Event) => {
          const ev = e as DragEvent;
          ev.dataTransfer!.setData('text/plain', String(i));
          ev.dataTransfer!.effectAllowed = 'move';
          (row as HTMLElement).style.opacity = '0.5';
        });
        row.addEventListener('dragend', () => {
          (row as HTMLElement).style.opacity = '1';
        });
        row.addEventListener('dragover', (e: Event) => {
          e.preventDefault();
          (e as DragEvent).dataTransfer!.dropEffect = 'move';
        });
        row.addEventListener('drop', (e: Event) => {
          e.preventDefault();
          const ev = e as DragEvent;
          const fromIdx = parseInt(ev.dataTransfer!.getData('text/plain'), 10);
          const toIdx = parseInt((e.currentTarget as HTMLElement).dataset['index']!, 10);
          if (fromIdx === toIdx) return;
          const list = [...(state[activeCategory] ?? [])];
          const [removed] = list.splice(fromIdx, 1);
          if (!removed) return;
          list.splice(toIdx, 0, removed);
          list.forEach((s, idx) => (s.sort_order = idx));
          state[activeCategory] = list;
          render();
        });
      });
    }

    // Save
    body.querySelector('#btn-save')!.addEventListener('click', async () => {
      const feedback = body.querySelector<HTMLElement>('#save-feedback')!;
      const errEl = body.querySelector<HTMLElement>('#market-symbols-error')!;
      feedback.textContent = '';
      errEl.textContent = '';
      const symbols = state[activeCategory] ?? [];
      const payload = symbols.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        display: s.display ?? undefined,
      }));
      try {
        const res = await fetch('/api/admin/market-symbols', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ category: activeCategory, symbols: payload }),
        });
        if (!res.ok) {
          let errMsg = `Save failed (${res.status})`;
          try {
            const j = (await res.json()) as { error?: string };
            errMsg = j.error ?? errMsg;
          } catch {
            /* non-JSON response */
          }
          errEl.textContent = errMsg;
          return;
        }
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (json.error) {
          errEl.textContent = json.error;
          return;
        }
        feedback.textContent = 'Saved';
        feedback.style.color = 'var(--success,#38a169)';
        setTimeout(() => {
          feedback.textContent = '';
        }, 2000);
      } catch (err) {
        errEl.textContent = 'Failed to save.';
        console.error('[market-symbols] save error:', err);
      }
    });
  }

  async function load(): Promise<void> {
    const body = container.querySelector<HTMLElement>('#market-symbols-body')!;
    try {
      const res = await fetch('/api/admin/market-symbols', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as MarketSymbolsData | { error?: string };
      if ('error' in json && json.error) {
        body.innerHTML = `<p style="color:var(--error)">${escHtml(json.error)}</p>`;
        return;
      }
      state = {
        stock: (json as MarketSymbolsData).stock ?? [],
        commodity: (json as MarketSymbolsData).commodity ?? [],
        crypto: (json as MarketSymbolsData).crypto ?? [],
        sector: (json as MarketSymbolsData).sector ?? [],
      };
      render();
    } catch (err) {
      body.textContent = 'Failed to load market symbols.';
      console.error('[market-symbols] load error:', err);
    }
  }

  void load();
}
