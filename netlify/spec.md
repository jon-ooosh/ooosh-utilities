# Staging Calculator — Product Specification

**Version:** 2.4  
**Last updated:** 2026-02-24  
**Status:** Active development — accessories, 3D viewer, HireHop push all functional

---

## Overview

A web-based calculator for Ooosh Tours that computes staging/deck, leg, and hardware requirements from desired stage dimensions. Integrated with HireHop for live stock data, date-based availability, and one-click job pushing. Includes a 3D client-facing viewer with shareable links.

**Live URL:** Hosted on Netlify via the Ooosh Utilities repo  
**Auth:** Shared PIN via Staff Hub `localStorage` session  

---

## Architecture

```
public/
  staging-calculator.html  — Main calculator page
  staging-calculator.js    — All calc logic, UI, accessories, push (~2,400 lines)
  staging-calculator.css   — Styling
  stage-view.html          — 3D client viewer (Three.js, standalone) (~970 lines)
  
netlify/functions/
  staging-stock.js         — Fetches & parses HireHop stock (categories 445, 446, 448)
  staging-push.js          — Pushes items to HireHop job + adds job note with share link
```

### Data Flow

1. **Page load** → `staging-stock.js` fetches all staging stock from HireHop export API
2. **User enters dimensions** → client-side calculation engine tiles decks, assigns legs/combiners
3. **Optional: job number** → triggers `staging-job.js` to pull job dates → date-based availability check
4. **Accessories selection** → edge-by-edge handrail/step toggles with position control
5. **3D Viewer** → config compressed via pako into URL parameter → shareable link
6. **Push to HireHop** → `staging-push.js` adds items to job via `save_job.php` + adds note with 3D link

---

## Stock Data Source

### HireHop Categories
| Category ID | Name | Contains |
|------------|------|----------|
| 445 | Decks/Platforms | Litedeck and Steeldeck panels |
| 446 | Legs & Hardware | Legs, combiners, screwjacks, wheels |
| 448 | Staging Accessories | Handrails, steps |

### Item Name Parsing Patterns
- **Decks:** `(\d+)' x (\d+)' (litedeck|steeldeck)` → e.g. "8' x 4' Litedeck"
- **Legs:** `(\d+\.?\d*)" ...leg` → e.g. `24" / 2ft staging leg`
- **Combiners:** `2-in-1` or `4-in-1` + `combiner`
- **Handrails:** `(\d+)ft` or `(\d+)'` + `handrail` → e.g. "Litedeck 8ft open-style handrail - staging"
- **Steps:** `(\d+)ft` or `(\d+)'` + `step|tread` → e.g. "Staging step / box tread - 1ft high"

### Stock Cache
- 10-minute in-memory cache in `staging-stock.js`
- Stale-while-error fallback if HireHop returns 429/500
- Persists while Netlify Function container stays warm

---

## Calculation Engine

### Deck Tiling
- Auto-orientation: tries both orientations, picks fewer total decks
- Greedy fill: largest available deck first, then smaller to fill remainders
- Junction point mapping: every deck corner/intersection gets a support point

### Leg Assignment
- Perimeter corners: 1 leg each
- Perimeter edges (2+ decks meeting): 1 leg at each junction
- Interior T-junctions: combiner-compatible
- Interior crossings: combiner-compatible
- Combiner modes: "Prefer 4-in-1" / "Prefer 2-in-1" / "None"

### Height Calculation
- Combiner height offset: −6" (universal constant)
- Screwjack detection for non-standard heights
- Leg colour coding by height (physical paint colours)

---

## Accessories System

### Edge Selection
Each of the 4 edges (front, back, left, right) has independent toggles:
- **Handrail** — toggle on/off
- **Steps** — toggle on/off (only one edge can have steps at a time)
- **Step position** — when both handrail AND steps are on same edge, choose where the gap goes: Front / Middle / Back

### Handrail Calculation
- Greedy fill with available sizes (8ft → 4ft → 2ft)
- When steps share the same edge, a gap is calculated:
  - Steps are ~90cm (~3ft) wide
  - Gap rounds up to nearest handrail section (typically 4ft)
  - Gap position determined by step position selector

### Step Selection
- `pickBestStep()` finds the tallest step ≤ stage height
- Step width defaults to 36" (90cm) for gap calculation

---

## 3D Viewer (stage-view.html)

### Features
- Three.js WebGL renderer with orbit controls
- Accurate deck tiling with Litedeck visual approximation
- Leg rendering with combiner base plates
- **Perimeter leg inset** — legs nudged inward by radius so they tuck under decks
- Handrail rendering with posts, top rail, and mid rail
- **Handrail gap** for steps when both on same edge (position-aware)
- Step rendering with cascading treads and safety nosing
- Responsive, branded header with Ooosh logo
- OG meta tags for link previews
- Compressed URL config via pako deflate + base64url

### Config Object (passed via URL)
```javascript
{
  l: lengthInches,     // Stage length
  w: widthInches,      // Stage width
  h: heightInches,     // Stage height
  d: [[x,y,len,wid]...],  // Deck placements
  j: [[x,y,type]...],     // Junction points
  cm: 'prefer4in1',       // Combiner mode
  u: 'imperial',          // Display unit
  acc: {                   // Accessories
    front: { handrail: bool, steps: bool, stepPosition: 'middle' },
    back:  { handrail: bool, steps: bool, stepPosition: 'middle' },
    left:  { handrail: bool, steps: bool, stepPosition: 'middle' },
    right: { handrail: bool, steps: bool, stepPosition: 'middle' },
  }
}
```

---

## HireHop Integration

### Push to Job (`staging-push.js`)
- Accepts `{ jobId, items: [{hirehopId, qty}], shareLink }`
- Adds items via `save_job.php` with `"b{id}": qty` format (hire items)
- Adds job note via `notes_save.php` with staging details + 3D viewer link
- Non-blocking note — item push succeeds even if note fails

### Job Note Format
```
🏗️ Staging Calculator — items added automatically
X item types, Y total pieces added.

3D Stage Preview:
https://[site]/stage-view.html?c=[compressed-config]

Added: DD/MM/YYYY HH:MM:SS
```

---

## UI Features

### Add to Job Button
- Always visible in results
- **With job number:** Active green button — "📤 Add to Job 12345"
- **Without job number:** Disabled grey button — "Enter a HireHop job number above"
- Confirmation dialog before pushing
- Success/failure feedback with auto-reset

### In-Stock Alternatives
- When optimal layout requires decks not in stock, suggests alternative using only available decks
- Green banner toggle between optimal and in-stock layouts

---

## Known Physical Constants
- Combiner height offset: 6 inches (universal)
- Screwjack ranges: 8" (2-5.5" usable), 19.5" (2-13.5" usable)
- Wheel finished heights: 4" wheel → 12" finished, 6" → 6", 8" → 8"
- Leg colours: 12"=White, 24"=Green, 30"=Orange, 38"=Blue, 48"=Silver
- Steps width: ~90cm (~36")
- Handrail gap for steps: rounded to nearest 4ft (48")

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-19 | Initial calculator — dimensions, tiling, parts list |
| 1.1 | 2026-02-20 | Unit toggle, ft/in input, smart rounding, 12" carry fix |
| 2.0 | 2026-02-23 | Live HireHop stock, date-based availability |
| 2.1 | 2026-02-23 | Auto-orientation, in-stock alternatives |
| 2.2 | 2026-02-23 | Job number input, date auto-pull, 3D viewer |
| 2.3 | 2026-02-23 | 10-min stock cache, Ooosh branding, share links, OG meta |
| 2.4 | 2026-02-24 | Accessories (handrails+steps), step position selector, 3D accessories rendering, HireHop push with job notes, push button fix |

---

## Transcript History
- Planning: `/mnt/transcripts/2026-02-19-13-14-11-staging-calculator-planning.txt`
- Clarifications: `/mnt/transcripts/2026-02-19-13-21-43-staging-calculator-clarifications.txt`
- Screwjacks & repo: `/mnt/transcripts/2026-02-19-13-51-02-staging-calculator-screwjacks-repo-structure.txt`
- Phase 1 build: `/mnt/transcripts/2026-02-19-20-00-13-staging-calculator-phase1-build.txt`
- Phase 1 feedback: `/mnt/transcripts/2026-02-23-10-58-15-staging-calculator-phase1-feedback.txt`
- v1.1 UX improvements: `/mnt/transcripts/2026-02-23-11-00-00-staging-calc-ux-improvements-v1.1.txt`
- v2.2 UI + dates + availability: `/mnt/transcripts/2026-02-23-14-08-01-staging-calc-v2.2-ui-dates-availability.txt`
- v2.2 job autopull + 3D viewer: `/mnt/transcripts/2026-02-23-15-20-52-staging-calc-v2.2-job-autopull-3d-viewer.txt`
- v2.3 job input field: `/mnt/transcripts/2026-02-23-15-22-13-staging-calc-v2.3-job-input-field.txt`
- v2.3 stock cache + branding: See chat "Cache function deployment and hire date sync fix"
- v2.4 accessories debug: `/mnt/transcripts/2026-02-23-23-03-40-staging-calc-v2.3-3d-legs-accessories-debug.txt`
- v2.4 deployment: *current session*

---

## Roadmap / Future Considerations

- **PDF quote generation** — export calculation as client-ready PDF
- **Multi-section stages** — L-shaped, T-shaped, or tiered configurations
- **Skirting/scrim** — add stage skirt accessories to edge selections
- **Transport calculation** — how many vans needed to move the gear
- **Weight calculation** — total load for venue floor loading checks