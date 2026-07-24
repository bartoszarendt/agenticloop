---
name: frontend-design-quality
description: Use when implementing or revising any frontend UI – landing pages, marketing sites, portfolios, app screens, dashboards, or components – and when choosing layout, typography, color, spacing, motion, or styling. Enforces a design-read first, real design systems, anti-slop discipline, accessibility, and a pre-flight visual audit so the interface does not look templated or AI-generated.
metadata:
  area: frontend-design-quality
  side_effects: writes-files
  credentials: none
  runs_scripts: none
---

# Frontend design

Good UI is not a default aesthetic applied on top of code. It is a decision made before the
first line: read the brief, pick a direction that fits the audience, then build it without the
tells that mark output as machine-generated. This skill is the engineer's domain reference for any
task that changes how a feature looks, feels, moves, or is interacted with. The workflow authority
is still the Agentic Loop: scope from the task record, build under [[tdd-implementation]], prove it
under [[verification-evidence]], and accept under [[review-and-accept]].

Stack assumptions below (React/Tailwind/Motion) are defaults. When the target project uses a
different stack, keep the principles and translate the mechanics.

## 1. Read the brief before generating

Most weak UI comes from jumping to a default look instead of reading the room. Before any markup,
infer and state a one-line **design read**:

> "Reading this as: <page or surface kind> for <audience>, with a <vibe> language, leaning toward
> <design system or aesthetic family>."

Signals to read: surface kind (landing, portfolio, dashboard, app screen, redesign), vibe words the
user used, reference URLs or products named, the audience (the audience picks the aesthetic, not
your taste), existing brand assets, and quiet constraints (accessibility-critical, public-sector,
regulated, trust-first) that override aesthetic preference.

If the read genuinely diverges, ask **one** clarifying question. If you can infer confidently, state
the read and proceed – do not stall.

## 2. Three dials

After the read, set three values and let them gate layout, motion, and density:

- `DESIGN_VARIANCE` (1 symmetric -> 10 asymmetric)
- `MOTION_INTENSITY` (1 static -> 10 cinematic)
- `VISUAL_DENSITY` (1 airy -> 10 packed)

Defaults `7 / 6 / 4` for marketing surfaces. Trust-first / regulated / accessibility-critical pulls
all three down (`3 / 2 / 5`). Dashboards and data UI raise density and lower variance. Overrides
happen conversationally, never by asking the user to edit a config.

## 3. Use a real design system when the brief implies one

If the brief reads as an established system, install and use the **official** package rather than
recreating its CSS or importing tokens then overriding them: Fluent, Material 3, Carbon, Polaris,
Atlaskit, Primer, GOV.UK Frontend, USWDS, Radix Themes, shadcn/ui, or Tailwind utilities for modern
SaaS. **One system per project.** When the brief is an aesthetic (glassmorphism, bento, brutalism,
editorial, dark tech) there is no official package – build it honestly with native CSS plus a
maintained library, and label borrowed inspiration as such in comments.

Before importing any third-party library, check the project manifest and output the install command
if it is missing. Never assume a package exists.

## 4. Anti-default discipline

Reach past the machine defaults deliberately:

- No auto AI-purple/blue glow gradients; one accent under ~80% saturation, locked across the page.
- Avoid `Inter` as a reflex default; pick a brand-appropriate face. Serif only when the brand is
  genuinely editorial/luxury and you can say why.
- No centered-hero-over-dark-mesh, no three identical feature cards, no generic glass on everything.
- Cards only when elevation marks real hierarchy; otherwise group with borders, dividers, or space.
- One corner-radius scale, one icon family, one copy register, one theme (sections do not invert).

## 5. Mandatory pre-flight audit (a failing item is shipping broken work)

- **Hero fits the first viewport**: headline <= 2 lines, subtext <= 20 words, CTA visible without
  scrolling. A 4-line headline is a font-size error, not a copy-length one.
- **One nav line on desktop**, height <= 80px.
- **One label per CTA intent** across the whole page; CTA text never wraps at desktop.
- **Contrast**: every button, form input, placeholder, focus ring, and helper text passes WCAG AA
  (4.5:1 body, 3:1 large). No white-on-white CTAs, no placeholder-as-label.
- **Layout variety**: a layout family appears at most once; max two consecutive image+text splits;
  eyebrows limited to one per three sections.
- **Real images, not unlabeled div fakes**: use a real or generated image,
  `picsum.photos/seed/...` placeholders, or a clearly-labeled TODO slot. Do not present CSS mock UI
  as a real product screenshot; label it as a concept/mock when real assets do not exist. Never
  hand-roll decorative SVG icons.
- **Full interactive states**: loading (skeletons, not spinners), empty, error, and tactile
  `:active` feedback – not just the happy path.
- **Copy self-audit**: re-read every visible string; cut AI-cute phrasing and fake-precise numbers.

For dashboards, data tables, charts, forms, navigation, and mobile/native surfaces, also use the
product UI checklist below.

## 6. Motion and accessibility guardrails

- Animate only `transform` and `opacity`. Never bind animations to scroll via
  `addEventListener("scroll")` or drive continuous values through component state; use the
  framework's motion-value / scroll hooks, `IntersectionObserver`, or CSS scroll-driven animations.
- Every animation must be motivated (hierarchy, storytelling, feedback, or state). "It looked cool"
  is not a reason. If `MOTION_INTENSITY > 3`, honor `prefers-reduced-motion` and collapse to static.
- Design light and dark together from the start; keep hierarchy, brand, and contrast intact in both.
  Avoid pure `#000`/`#fff`. Respect `prefers-color-scheme` unless the brand insists on one mode.

## 7. Product UI checklist

The marketing-page rules above cover landing pages, portfolios, and redesigns. This checklist
covers dashboards, data tables, charts, forms, navigation, and mobile/native surfaces. Use the
sections relevant to the surface. The critical and high-priority groups are a hard final pass.

### Accessibility (critical)

- Text contrast >= 4.5:1 (3:1 for large text 18px+). Verify in both light and dark.
- Visible focus rings (2-4px) on every interactive element; never remove them.
- Descriptive `alt` for meaningful images; `aria-label` or native accessibility label for
  icon-only buttons.
- Tab order matches visual order; full keyboard support, including a path out of every modal.
- Sequential heading hierarchy (`h1` -> `h6`), no skipped levels.
- Never convey meaning by color alone; pair it with text, icon, or pattern.
- Respect `prefers-reduced-motion` and system text scaling without truncation or layout breakage.

### Touch and interaction (critical)

- Touch targets >= 44x44pt (iOS) / 48x48dp (Android); expand hit area when the glyph is smaller.
- Keep >= 8px gaps between adjacent touch targets.
- Use tap/click for primary actions; never rely on hover alone.
- Disable buttons during async work and show progress.
- Visual press feedback within about 100ms; do not redefine system gestures such as back-swipe or
  pinch-zoom.
- Keep primary controls clear of notches, Dynamic Island, and gesture bars.

### Performance (high)

- Use WebP/AVIF, responsive `srcset`, and lazy-load below-the-fold media.
- Declare `width`/`height` or `aspect-ratio` to keep CLS < 0.1; reserve space for async content.
- Use `font-display: swap`; preload only critical fonts.
- Animate `transform`/`opacity` only; batch DOM reads then writes; debounce/throttle scroll/resize.
- Virtualize lists of 50+ items; keep per-frame work under about 16ms for 60fps.
- Use skeletons or shimmer for operations over about 1s, not long blocking spinners.

### Layout and responsive (high)

- Use `width=device-width, initial-scale=1`; never disable zoom.
- Build mobile-first, then scale up with systematic breakpoints such as 375 / 768 / 1024 / 1440.
- Body text >= 16px on mobile; 35-60 chars/line mobile, 60-75 desktop.
- No horizontal scroll on mobile; consistent desktop max-width.
- Use a 4/8pt spacing system, a defined z-index scale, and `min-h-dvh` over `100vh`.
- Fixed bars reserve safe padding so content is not hidden behind them.

### Forms, navigation, charts

- Forms need visible labels, field-local errors, submit loading/success/error, semantic input types,
  autofill support, first-invalid-field focus, and `aria-live`/`role="alert"` for screen readers.
- Navigation needs a visible current location, predictable back behavior, deep-linkable screens, and
  clear separation between primary, secondary, and destructive actions.
- Charts need the right chart type for the data, nearby legends, keyboard/touch reachable
  interactions, table alternatives, screen-reader summaries, empty/loading/error states, and
  non-color-only encoding.

### Light/dark and visual polish

- Primary text >= 4.5:1 and secondary text >= 3:1 in both themes.
- Borders, dividers, focus rings, disabled states, and interaction states must remain visible in
  both themes.
- Use one icon family with consistent stroke width and sizing tokens; vector only, no emoji as
  structural icons.
- Press states use color/opacity/elevation without shifting layout bounds.
- Use official brand assets only, with correct proportions and clear space.

## 8. The em-dash and AI-tell ban

The em-dash (`U+2014`) and en-dash-as-separator (`U+2013`) are banned in all user-visible text:
headlines, labels, buttons, body, captions, attribution, and alt text. Use a regular hyphen, a
comma, a colon, parentheses, or two sentences. A single visible em-dash fails the pre-flight audit.

Also banned by default (allow only when the brief explicitly calls for them): version/status eyebrows
in the hero, section-number eyebrows (`001 / Capabilities`), decorative status dots, locale/weather
strips, scroll cues, atmospheric photo-credit captions, and generic placeholder names/avatars.

## 9. Redesigns

Detect the mode first: greenfield, redesign-preserve, or redesign-overhaul. For a preserve redesign,
audit the current state and extract brand tokens before changing anything, and never silently change
URL structure, nav labels, form field names, the logo, or legal/consent copy. SEO and analytics
regressions are the biggest redesign risk.

## Red flags

- Code was written before any design read was stated.
- A design-system's tokens were imported, then 90% overridden by hand.
- The page claims motion but is static, or animates `width`/`height`/`top`/`left`.
- A CTA wraps at desktop, the hero overflows the fold, or contrast fails.
- An unlabeled CSS mockup presented as a real product screenshot, hand-rolled SVG icon, or AI-purple
  gradient shipped as a default.
- Any em-dash is visible in the rendered output.
- A redesign changed routes, nav labels, or form field names without explicit approval.

## See also

- [[tdd-implementation]] for the build cycle behind a component or screen.
- [[verification-evidence]] before claiming a UI change is done.
- [[review-and-accept]] for design-quality acceptance.

## Sources

Distilled from two MIT-licensed community skills, adapted to Agentic Loop conventions:
`taste-skill` (anti-slop frontend taste) and `ui-ux-pro-max` (UI/UX guideline database).