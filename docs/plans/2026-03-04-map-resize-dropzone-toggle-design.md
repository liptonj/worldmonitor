# Map Width Resizer & Drop Zone Toggle

**Date:** 2026-03-04
**Status:** Approved

## Problem

1. The map column width is fixed at 60% on ultra-wide (>=1600px) screens with no way to adjust it horizontally.
2. The "DROP PANELS HERE TO MOVE THEM BELOW THE MAP" zone is always visible, consuming vertical space even when unused.

## Solution

Two features targeting the ultra-wide (>=1600px) grid layout.

### Feature 1: Horizontal Map Width Resizer

Insert a vertical drag handle (`map-width-resize-handle`) between `map-section` and `panels-grid` inside `main-content`. The handle is a thin bar (4px wide, full height) that only appears at >= 1600px.

**Drag behavior:**
- Track `clientX` on mousedown and compute a new percentage split.
- Clamp between 30% min and 80% max to keep both sides usable.
- Update `grid-template-columns` to `{pct}% 4px 1fr` (middle column is the handle).
- Persist ratio to `localStorage` key `map-width-ratio`. Restore on load (default: 60%).

**Double-click presets:**
- Double-click cycles through 50% -> 60% -> 70% -> 50%.
- Uses the smooth transition class (`map-container-smooth` pattern) for animated snapping.

**Map rendering:**
- Set `isResizing(true)` during drag to suppress re-renders (same pattern as vertical resize).
- Call `render()` on mouseup.

**CSS:**
- `.map-width-resize-handle`: `width: 4px`, `cursor: ew-resize`, `background: var(--border-subtle)`, accent on hover.
- Grid becomes: `grid-template-columns: var(--map-width, 60%) 4px 1fr`.
- Hidden below 1600px (grid layout not active).

### Feature 2: Drop Zone Toggle

Add a toggle button to the map header bar (alongside existing pin/fullscreen buttons).

**Button:**
- Icon: bottom-panel/layout indicator (SVG).
- Tooltip: "Toggle bottom panels area".
- Active/highlighted state when drop zone is visible.

**Behavior:**
- Default state: hidden (drop zone `display: none`, zero height).
- Click toggles `map-bottom-grid` visibility.
- Persist state to `localStorage` key `map-bottom-grid-visible`.
- When hiding with panels present: move panels back to `panels-grid` (append to end).
- When showing: display empty drop zone with placeholder text.

**Auto-show during drag:**
- Even when toggled off, if user starts dragging a panel, briefly show the drop zone as a target.
- On drag end, re-hide if toggle is off and nothing was dropped there.

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/panel-layout.ts` | Add width resize handle element, drop zone toggle button, toggle logic, auto-show during drag |
| `src/app/event-handlers.ts` | Add `setupMapWidthResize()` method mirroring `setupMapResize()` pattern |
| `src/styles/main.css` | Width resize handle styles, grid template update with CSS variable, responsive rules |
| `src/styles/panels.css` | Drop zone hidden by default, toggle visibility classes |

## Constraints

- Only applies to >= 1600px screens (ultra-wide grid layout).
- Below 1600px the layout is single-column flex and these features are not relevant.
- Must not break existing vertical height resize, panel drag-and-drop, or mobile layout.
