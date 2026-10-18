# HealthBridge visual identity

HealthBridge should look like a healthcare continuity service: clear, calm, trustworthy, clinical but human. It should not look like a generic dashboard, a fintech product or an AI chat app. This page explains the choices so new screens stay consistent.

The current look (October 2026) is **sky and white**. It fuses patterns from the reference designs in `design/` (not committed):

| Reference | What HealthBridge takes from it |
|---|---|
| Wellness site (`main_1`–`main_5`) | Large, light headlines; numbered section openings (`// Label … [ 01 ]`); soft rounded cards; pill buttons with an arrow tile; a featured card in a deep colour beside white ones (bento); an FAQ accordion with round +/− buttons; a calm column footer with a large faint wordmark |
| Energy site (`1`) | The mono label voice (`01 / WHO WE ARE`); a facts row with thin dividers; a white data card floating over a coloured panel; numbered steps; one strong colour band for the closing call to action |
| Home-robot site (`2`) | Segmented pill controls (used for tabs); round icon tiles in buttons; the floating pill header |

What was left out: photography (HealthBridge stores no photos of people), marketing statistics (only true product facts are shown), decorative motion and heavy uppercase display type.

## The mark

Two points (patient and doctor) joined by a bridge arc, with a small medical cross between them, on a soft-cornered sky gradient tile (`#38bdf8` → `#0369a1`). The wordmark is "Health**Bridge**", with "Bridge" in the care colour. The mark is in `components/ui/Logo.jsx` and in `public/favicon.svg`.

## Colour

Tokens live in `styles/index.css` and switch automatically for dark mode (a navy theme). Every text pairing meets WCAG AA, including state colours on their own tints, and a badge's tint on a tinted box (at least 4.8:1; computed for both themes, and checked with axe-core on about 30 pages).

| Token | Light | Use |
|---|---|---|
| `surface` | `#f5f9fd` cool white | Page background |
| `surface-raised` | `#ffffff` | Cards, inputs, dialogs |
| `surface-muted` | `#edf3f9` | Quiet areas inside cards, segmented controls |
| `border` / `border-strong` | `#dce6f0` / `#c3d3e3` | Structure / controls |
| `text` / `text-muted` / `text-subtle` | `#0f2236` / `#43566b` / `#566a7e` | Navy ink and cool greys |
| `primary` | `#0369a1` deep sky | Care and action: the one main action of an area, links, active navigation (white on it: 5.9:1) |
| `primary-soft` | `#e3f2fd` | Active navigation, icon tiles, verified marks |
| `accent` / `accent-soft` | `#0ea5e9` / `#e0f2fe` | Bright sky, **never for text**: dots, arcs, soft fills, to-dos |
| `success` | `#18663a` | Confirmed, paid, available, signed |
| `warning` | `#7a4900` | Pending, waiting, needs review |
| `attention` | `#923b16` | Needs a look, not an emergency |
| `danger` | `#a31f15` | Errors, urgent, rejected, failed, emergency numbers |
| `info` | `#375783` | Neutral information |
| `ai` / `ai-soft` | `#5a4fb5` / `#efedfb` | AI assistance only |

Two gradients, used sparingly: `bg-hero` (a soft sky wash for the landing hero, the sign-in panel and "what's next" cards) and `bg-band` (deep sky, always with white text: the featured principle, the closing call to action, the next appointment).

AI has its own quiet indigo so that it reads as an assistant layer, never as the product or as authority. AI elements use the "AI-generated" badge with the sparkle icon, the `ai` button variant, or the AI frame. They are never the care colour.

## Type

**Figtree** (variable, self-hosted, OFL) for everything people read; the system **monospace** for labels.

- **Page title:** about 2rem, **medium** weight, tight tracking (−0.02em), the only `<h1>`. Above it, the eyebrow: a small mono uppercase label in the care colour, with a sky dot, saying where you are (`Eyebrow`).
- **Section title:** 1.125rem medium, with a soft icon tile.
- **Landing headlines:** 2.5–3.5rem medium, tracking −0.03em.
- **Body:** 1rem regular. **Secondary text:** 0.875rem.
- **Labels and figures:** mono, 0.6875rem, uppercase, spaced (navigation groups, section openings, captions under figures).

Semibold is kept for names, the wordmark and active navigation.

## Shape and surfaces

- **Buttons:** pills. Primary is solid deep sky; secondary is white with a border; subtle is text only; destructive is red; AI uses the indigo variant. `arrow` adds the round arrow tile for calls to action that move the person on ("Get started →").
- **Inputs:** rounded-xl, white, a clear border, and a soft sky halo on focus.
- **Cards:** `rounded-card` (1.25rem), white on the cool page, a light border and a very soft shadow. Cards that are links lift slightly on hover (`shadow-raised`).
- **Panels:** rounded-3xl or 2rem for hero areas, the sign-in panel and dialogs.
- **Tabs:** a segmented pill control; the selected tab is a white pill.
- **Header:** sticky and translucent in the app; a floating pill bar on public pages. The sidebar stays in view on long pages.

Not everything needs a card. Group related lines inside one card, as in the "Your care" rows on the patient home. Show history as a timeline rail, not as a grid of tiles.

## Status

One vocabulary everywhere (`StatusBadge`). Each state has a tone and an icon, so it never relies on colour alone.

| State | Tone | Icon | Examples |
|---|---|---|---|
| Success | success | check | Confirmed, Paid, Available, Signed |
| Pending | warning | clock | Pending payment, Processing, Draft, Invited |
| Attention | attention | triangle | Needs attention, No-show, Open |
| Error | danger | octagon | Urgent, Failed, Rejected, Suspended, Disabled |
| Verified | primary | badge-check | Verified doctor, Verified lab value |
| In progress | primary | dot | Checked in, In consultation, Live |
| Completed / ended | neutral | check / x | Completed, Cancelled, Ended, Replaced |

To-dos that are not urgent (a check-in to answer, a payment to make) use the soft sky treatment; only warning signs use danger.

## Healthcare patterns

| Pattern | Treatment |
|---|---|
| Doctor identity | Initials avatar, name, speciality, and a "Verified doctor" badge-check |
| Appointments | Time first, then the person, mode icon (video or clinic) and status. The next one sits on the deep sky band with the bridge arc |
| Documents | Type icon (flask, scan, file), with "Secure: passed the safety check" |
| Prescriptions | A signed slip with a green border and seal icon; drafts dashed |
| Timeline | A vertical rail with an icon per event and a provenance badge (patient reported, doctor reported, verified) |
| Privacy and consent | Shield icons, "Shared until …", and lock icons where nothing is shared |
| Relationships | The bridge motif: you and your doctor joined by an arc |
| Emergencies | Always visible, never decorative: 112 and 108 in the danger colour |

## Icons

One library only, **lucide-react**, at 16px (`h-4 w-4`) inline and 20px in navigation. Health icons are used where they carry meaning, never as decoration.

## Tables

Tables are used only where comparison helps: admin users, the audit log and queues. Patient-facing views use lists, cards and timelines. On phones, tables keep the primary action visible without sideways scrolling.
