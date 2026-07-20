# Frontend redesign — visual polish

Scope: `public/index.html`, `public/style.css`, `public/app.js` only. No new dependencies, no build step (keeps HANDOFF.md's "deliberately minimal" stack). No backend changes.

## Visual identity
- Dark base kept. Accent palette: felt-green for primary/confirm actions, amber/gold for winners & highlights, red for eliminate. Rounded corners, subtle shadows for depth.
- Slightly bolder headings with letter-spacing instead of default system-ui look.
- Real favicon via inline SVG emoji (🎰), closing a HANDOFF gap for free.

## Roulette wheel
- Replace text-only `#wheel` div with a CSS `conic-gradient` wheel (alternating colored slices) + a pointer marker. JS rotates it to a random multi-turn angle on spin, settles, then shows the result in a badge. Pure CSS/JS, no images/libraries.

## Responsive layout
- Nav: top tab bar on desktop, fixed bottom tab bar on narrow viewports (same markup, media query only).
- Larger tap targets (~44px min height) and single-column content below ~600px.

## Tables → cards on mobile
- Games/Players tables keep `<table>` markup on desktop; below the breakpoint, rows restack as cards via CSS (`data-label` attributes + `display:grid`), no markup duplication.

## Small touches
- Game chips: tactile pill look, distinct checked-state color.
- History items: card style with a left accent bar colored by match status.

## Out of scope
- No new pages/tabs, no backend/API changes, no new JS behavior beyond the wheel rotation and responsive table restructuring.
