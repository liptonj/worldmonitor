# Map Width Resizer & Drop Zone Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a horizontal drag handle to resize the map width and a toggle button to show/hide the bottom drop zone.

**Architecture:** Two independent features that only apply at >= 1600px (ultra-wide grid layout). The horizontal resizer modifies `grid-template-columns` on `.main-content` via a new drag handle element between map-section and panels-grid. The drop zone toggle adds a button to the map header that controls visibility of `map-bottom-grid` with localStorage persistence.

**Tech Stack:** TypeScript (vanilla DOM), CSS Grid, localStorage

---

### Task 1: Add Horizontal Width Resize Handle (HTML + CSS)

**Files:**
- Modify: `src/app/panel-layout.ts:193-216` (HTML template)
- Modify: `src/styles/main.css:16108-16183` (ultra-wide media query)

**Step 1: Add the resize handle element to the template**

In `src/app/panel-layout.ts`, find the closing `</div>` of `.map-section` and the opening of `.panels-grid`:

```typescript
// BEFORE (lines 214-215):
        </div>
        <div class="panels-grid" id="panelsGrid"></div>

// AFTER:
        </div>
        <div class="map-width-resize-handle" id="mapWidthResizeHandle"></div>
        <div class="panels-grid" id="panelsGrid"></div>
```

**Step 2: Add CSS for the width resize handle**

In `src/styles/main.css`, inside the `@media (min-width: 1600px)` block (after line 16116), add:

```css
  .map-width-resize-handle {
    grid-column: 2;
    grid-row: 1;
    width: 6px;
    cursor: ew-resize;
    background: var(--border-subtle);
    transition: background 0.15s;
    z-index: 10;
    position: relative;
  }

  .map-width-resize-handle:hover,
  .map-width-resize-handle:active {
    background: var(--accent);
  }
```

**Step 3: Update the grid template to include the handle column**

In `src/styles/main.css`, change the `.main-content` grid at line 16112:

```css
/* BEFORE: */
    grid-template-columns: 60% 1fr;

/* AFTER: */
    grid-template-columns: var(--map-width, 60%) 6px 1fr;
```

**Step 4: Update `.panels-grid` grid-column**

Change `.panels-grid` at line 16174:

```css
/* BEFORE: */
    grid-column: 2;

/* AFTER: */
    grid-column: 3;
```

**Step 5: Update `.main-content.map-hidden` to hide handle**

Change the `.main-content.map-hidden` rule at line 16118-16120:

```css
/* BEFORE: */
  .main-content.map-hidden {
    grid-template-columns: 1fr;
  }

/* AFTER: */
  .main-content.map-hidden {
    grid-template-columns: 1fr;
  }

  .main-content.map-hidden .map-width-resize-handle {
    display: none;
  }

  .main-content.map-hidden .panels-grid {
    grid-column: 1;
  }
```

**Step 6: Hide the width handle below 1600px**

Add a rule outside the media query (the handle simply won't appear since it's not in the grid, but add explicit hiding for safety):

```css
.map-width-resize-handle {
  display: none;
}

@media (min-width: 1600px) {
  .map-width-resize-handle {
    display: block;
  }
  /* ... existing rules ... */
}
```

**Step 7: Verify the handle renders**

Run the dev server and confirm:
- At >= 1600px: a thin vertical bar appears between map and panels
- At < 1600px: no handle visible
- When map is hidden: no handle visible

**Step 8: Commit**

```bash
git add src/app/panel-layout.ts src/styles/main.css
git commit -m "feat: add horizontal map width resize handle element and CSS"
```

---

### Task 2: Implement Horizontal Resize Drag Logic

**Files:**
- Modify: `src/app/event-handlers.ts` (add `setupMapWidthResize()` method after `setupMapResize()` at ~line 740)

**Step 1: Add the `setupMapWidthResize` method**

In `src/app/event-handlers.ts`, after the `setupMapResize()` method (after line 739), add:

```typescript
  setupMapWidthResize(): void {
    const mainContent = document.querySelector('.main-content') as HTMLElement;
    const resizeHandle = document.getElementById('mapWidthResizeHandle');
    if (!mainContent || !resizeHandle) return;

    const MIN_PCT = 30;
    const MAX_PCT = 80;
    const PRESETS = [50, 60, 70];

    const savedRatio = localStorage.getItem('map-width-ratio');
    if (savedRatio) {
      const numeric = Number.parseFloat(savedRatio);
      if (Number.isFinite(numeric) && numeric >= MIN_PCT && numeric <= MAX_PCT) {
        mainContent.style.setProperty('--map-width', `${numeric}%`);
      } else {
        localStorage.removeItem('map-width-ratio');
      }
    }

    let isResizing = false;
    let startX = 0;
    let startPct = 60;

    const getCurrentPct = (): number => {
      const val = mainContent.style.getPropertyValue('--map-width');
      const parsed = Number.parseFloat(val);
      return Number.isFinite(parsed) ? parsed : 60;
    };

    const endResize = () => {
      if (!isResizing) return;
      isResizing = false;
      this.ctx.map?.setIsResizing(false);
      this.ctx.map?.render();
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const pct = getCurrentPct();
      localStorage.setItem('map-width-ratio', `${pct}`);
    };

    resizeHandle.addEventListener('mousedown', (e) => {
      if (window.innerWidth < 1600) return;
      isResizing = true;
      startX = e.clientX;
      startPct = getCurrentPct();
      this.ctx.map?.setIsResizing(true);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    resizeHandle.addEventListener('dblclick', () => {
      if (window.innerWidth < 1600) return;
      const current = getCurrentPct();
      const closest = PRESETS.reduce((prev, p) =>
        Math.abs(p - current) < Math.abs(prev - current) ? p : prev
      );
      const idx = PRESETS.indexOf(closest);
      const next = PRESETS[(idx + 1) % PRESETS.length];

      this.ctx.map?.setIsResizing(true);
      mainContent.style.setProperty('--map-width', `${next}%`);
      localStorage.setItem('map-width-ratio', `${next}`);

      setTimeout(() => {
        this.ctx.map?.setIsResizing(false);
        this.ctx.map?.render();
      }, 100);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const deltaX = e.clientX - startX;
      const totalWidth = mainContent.offsetWidth;
      const deltaPct = (deltaX / totalWidth) * 100;
      const newPct = Math.max(MIN_PCT, Math.min(startPct + deltaPct, MAX_PCT));
      mainContent.style.setProperty('--map-width', `${Math.round(newPct * 10) / 10}%`);
    });

    document.addEventListener('mouseup', endResize);
    window.addEventListener('blur', endResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) endResize();
    });
  }
```

**Step 2: Call `setupMapWidthResize` from the initialization flow**

Find where `setupMapResize()` is called in `event-handlers.ts` and add the new call after it. Search for `this.setupMapResize()` and add `this.setupMapWidthResize()` on the next line.

**Step 3: Verify drag behavior**

Run the dev server at >= 1600px and confirm:
- Dragging the handle left/right changes the map column width
- Width is clamped between 30% and 80%
- Double-clicking cycles through 50% -> 60% -> 70%
- Releasing the mouse saves to localStorage
- Refreshing the page restores the saved width

**Step 4: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "feat: implement horizontal map width resize drag logic with presets"
```

---

### Task 3: Add Drop Zone Toggle Button (HTML + CSS)

**Files:**
- Modify: `src/app/panel-layout.ts:200-209` (map header buttons area)
- Modify: `src/styles/main.css` (button styling)
- Modify: `src/styles/panels.css:1488-1505` (drop zone default hidden)

**Step 1: Add the toggle button to the map header**

In `src/app/panel-layout.ts`, find the button group (line 200-208). Add a new button before the fullscreen button:

```typescript
// In the div with style="display:flex;align-items:center;gap:2px", add before mapFullscreenBtn:
              <button class="map-pin-btn" id="mapBottomGridToggle" title="Toggle bottom panels area">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
              </button>
```

The SVG is a panel-with-bottom-section icon (rectangle with horizontal line near bottom).

**Step 2: Make drop zone hidden by default**

In `src/styles/panels.css`, add to the `.map-bottom-grid` rule at line 1488:

```css
.map-bottom-grid {
  /* ... existing styles ... */
}

.map-bottom-grid.bottom-grid-hidden {
  display: none !important;
}
```

**Step 3: Add active state for the toggle button**

In `src/styles/main.css`, add styling (near the existing `.map-pin-btn` styles):

```css
.map-pin-btn.bottom-toggle-active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
```

**Step 4: Verify the button renders**

Run the dev server and confirm the new button appears in the map header alongside pin/fullscreen buttons.

**Step 5: Commit**

```bash
git add src/app/panel-layout.ts src/styles/main.css src/styles/panels.css
git commit -m "feat: add drop zone toggle button to map header"
```

---

### Task 4: Implement Drop Zone Toggle Logic

**Files:**
- Modify: `src/app/panel-layout.ts` (add toggle setup method and call it from `createPanels`)

**Step 1: Add setup method for the toggle**

In `src/app/panel-layout.ts`, add a new method (after `ensureCorrectZones` at ~line 947):

```typescript
  private setupBottomGridToggle(): void {
    const toggleBtn = document.getElementById('mapBottomGridToggle');
    const bottomGrid = document.getElementById('mapBottomGrid');
    const panelsGrid = document.getElementById('panelsGrid');
    if (!toggleBtn || !bottomGrid || !panelsGrid) return;

    const isVisible = localStorage.getItem('map-bottom-grid-visible') === 'true';

    const applyState = (visible: boolean) => {
      if (visible) {
        bottomGrid.classList.remove('bottom-grid-hidden');
        toggleBtn.classList.add('bottom-toggle-active');
      } else {
        // Move any panels back to the sidebar before hiding
        const panelsInBottom = Array.from(bottomGrid.querySelectorAll('.panel')) as HTMLElement[];
        panelsInBottom.forEach(panelEl => panelsGrid.appendChild(panelEl));
        if (panelsInBottom.length > 0) this.savePanelOrder();

        bottomGrid.classList.add('bottom-grid-hidden');
        toggleBtn.classList.remove('bottom-toggle-active');
      }
      localStorage.setItem('map-bottom-grid-visible', String(visible));
    };

    // Apply initial state
    applyState(isVisible);

    toggleBtn.addEventListener('click', () => {
      const currentlyVisible = !bottomGrid.classList.contains('bottom-grid-hidden');
      applyState(!currentlyVisible);
    });
  }
```

**Step 2: Call `setupBottomGridToggle` from `createPanels`**

In the `createPanels` method, after `this.applyPanelSettings()` (line 779), add:

```typescript
    this.setupBottomGridToggle();
```

**Step 3: Verify toggle behavior**

Run the dev server at >= 1600px and confirm:
- Drop zone is hidden by default on first visit
- Clicking the toggle button shows the drop zone with its placeholder text
- Clicking again moves any panels back to sidebar and hides the zone
- State persists across page refreshes

**Step 4: Commit**

```bash
git add src/app/panel-layout.ts
git commit -m "feat: implement drop zone toggle with localStorage persistence"
```

---

### Task 5: Auto-show Drop Zone During Panel Drag

**Files:**
- Modify: `src/app/panel-layout.ts` (update `makeDraggable` and `handlePanelDragMove`)

**Step 1: Show drop zone on drag start when hidden**

In `makeDraggable` (line 994), after `el.classList.add('dragging')` (line 1029), add logic to temporarily reveal the drop zone:

```typescript
        el.classList.add('dragging');
        // Temporarily show bottom grid if hidden during drag
        const bg = document.getElementById('mapBottomGrid');
        if (bg?.classList.contains('bottom-grid-hidden')) {
          bg.classList.remove('bottom-grid-hidden');
          bg.dataset.autoShown = 'true';
        }
```

**Step 2: Re-hide drop zone on drag end if auto-shown and empty**

In `makeDraggable`, in the `onMouseUp` handler (line 1040), after `this.savePanelOrder()` (line 1046), add:

```typescript
        this.savePanelOrder();
        // Re-hide bottom grid if it was auto-shown and has no panels
        const bg = document.getElementById('mapBottomGrid');
        if (bg?.dataset.autoShown === 'true') {
          delete bg.dataset.autoShown;
          if (bg.children.length === 0) {
            bg.classList.add('bottom-grid-hidden');
          } else {
            // Panel was dropped there, so mark it as visible
            localStorage.setItem('map-bottom-grid-visible', 'true');
            document.getElementById('mapBottomGridToggle')?.classList.add('bottom-toggle-active');
          }
        }
```

**Step 3: Verify auto-show behavior**

Run the dev server and confirm:
- With drop zone toggled off, starting a panel drag reveals the drop zone
- Dropping the panel back in the sidebar re-hides the drop zone
- Dropping the panel in the drop zone keeps it visible and updates the toggle state
- Normal drag behavior (reordering panels) still works correctly

**Step 4: Commit**

```bash
git add src/app/panel-layout.ts
git commit -m "feat: auto-show drop zone during panel drag when toggled off"
```

---

### Task 6: Handle Window Resize and Map Hidden States

**Files:**
- Modify: `src/app/panel-layout.ts` (`ensureCorrectZones` method)
- Modify: `src/app/event-handlers.ts` (width resize cleanup on narrow)

**Step 1: Reset width resize on narrow screens**

In `src/app/event-handlers.ts`, inside `setupMapWidthResize`, add a window resize listener at the end of the method:

```typescript
    window.addEventListener('resize', () => {
      if (window.innerWidth < 1600) {
        mainContent.style.removeProperty('--map-width');
      } else {
        const saved = localStorage.getItem('map-width-ratio');
        if (saved) {
          const pct = Number.parseFloat(saved);
          if (Number.isFinite(pct) && pct >= MIN_PCT && pct <= MAX_PCT) {
            mainContent.style.setProperty('--map-width', `${pct}%`);
          }
        }
      }
    });
```

**Step 2: Hide toggle button on narrow screens**

In `src/styles/main.css`, in the mobile media query (or add one), hide the toggle button below 1600px:

```css
@media (max-width: 1599px) {
  #mapBottomGridToggle {
    display: none !important;
  }
}
```

**Step 3: Verify responsive behavior**

- Resize window from wide to narrow: map goes full width, handle disappears, toggle disappears
- Resize back to wide: saved width ratio is restored, handle reappears

**Step 4: Commit**

```bash
git add src/app/event-handlers.ts src/styles/main.css src/app/panel-layout.ts
git commit -m "feat: handle responsive states for width resize and drop zone toggle"
```

---

### Task 7: Final Integration Testing

**Step 1: Full test pass**

Verify all of the following at >= 1600px:
- [ ] Horizontal drag handle resizes map width (30-80% range)
- [ ] Double-click cycles through 50/60/70% presets
- [ ] Width persists to localStorage and restores on reload
- [ ] Vertical height resize still works independently
- [ ] Drop zone toggle button shows/hides the bottom area
- [ ] Toggle state persists across reloads
- [ ] Auto-show during drag works correctly
- [ ] Panels can be dragged between sidebar and bottom zone
- [ ] Panel order saves correctly for both zones
- [ ] Map renders correctly during and after resize (no artifacts)

Verify at < 1600px:
- [ ] No horizontal handle visible
- [ ] No toggle button visible
- [ ] Layout is single-column flex (unchanged)
- [ ] Existing mobile behavior unchanged

**Step 2: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: integration fixes for map resize and drop zone toggle"
```
