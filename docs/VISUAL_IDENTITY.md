# HealthBridge visual identity

HealthBridge should look like a healthcare continuity service: calm, trustworthy, clinical but human. It should not look like a generic dashboard, a fintech product or an AI chat app. This page explains the choices so new screens stay consistent.

## The mark

Two points (patient and doctor) joined by a bridge arc, with a small medical cross between them, in a soft-cornered teal tile. The wordmark is "Health**Bridge**", with "Bridge" in the care colour. The mark is in `components/ui/Logo.jsx` and in `public/favicon.svg`.

## Colour

Tokens live in `styles/index.css` and switch automatically for dark mode. Every text pairing meets WCAG AA.

| Token | Light | Use |
|---|---|---|
| `surface` | `#f8f6f1` warm paper | Page background |
| `surface-raised` | `#ffffff` | Cards, inputs, dialogs |
| `surface-muted` | `#f1eee6` | Quiet areas inside cards |
| `border` | `#e4dfd3` | Structure; shadows are almost absent |
| `text` / `text-muted` / `text-subtle` | `#15302b` / `#4a5d57` / `#5f706a` | Deep green-black ink, warm greys |
| `primary` | `#146c63` | Care and action: the one main action of an area |
| `success` | `#2d7a4f` | Confirmed, paid, available, signed |
| `warning` | `#8f5a0b` | Pending, waiting, needs review |
| `attention` | `#ad4f27` (clay) | Needs a look, not an emergency |
| `danger` | `#b1352c` | Errors, urgent, rejected, failed |
| `info` | `#2e6491` | Neutral information |
| `ai` / `ai-soft` | `#5a55a6` / `#efeefa` | AI assistance only |

AI has its own quiet indigo so that it reads as an assistant layer, never as the product or as authority. AI elements use the "AI-generated" badge with the sparkle icon, the `ai` button variant, or the dashed AI frame. They are never the care colour.

## Type

**Figtree** (variable, self-hosted, OFL). It is friendly and legible, and not the default dashboard font.

- **Page title:** 1.75rem semibold, the only `<h1>`. Above it sits a small uppercase eyebrow in the care colour saying where you are.
- **Section title:** 1.0625rem semibold.
- **Body:** 1rem regular.
- **Secondary text:** 0.875rem.

Bold is used for titles and names only.

## Shape and surfaces

- **Buttons:** soft pills. Primary is solid teal; secondary is white with a border; subtle is text only; destructive is red; AI uses the indigo variant.
- **Inputs:** rounded-xl, white, with a soft teal halo on focus.
- **Cards:** rounded-2xl, white on warm paper, with a border and no visible shadow.

Not everything needs a card. Group related lines inside one card, as in the "Your care" rows on the patient home. Show history as a timeline rail, not as a grid of tiles.

## Status

One vocabulary everywhere (`StatusBadge`). Each state has a tone and an icon, so it never relies on colour alone.

| State | Tone | Icon | Examples |
|---|---|---|---|
| Success | success | check | Confirmed, Paid, Available, Signed |
| Pending | warning | clock | Pending payment, Processing, Draft, Invited |
| Attention | attention (clay) | triangle | Needs attention, No-show, Open |
| Error | danger | octagon | Urgent, Failed, Rejected, Suspended, Disabled |
| Verified | primary | badge-check | Verified doctor, Verified lab value |
| In progress | primary | dot | Checked in, In consultation, Live |
| Completed / ended | neutral | check / x | Completed, Cancelled, Ended, Replaced |

## Healthcare patterns

| Pattern | Treatment |
|---|---|
| Doctor identity | Initials avatar, name, speciality, and a "Verified doctor" badge-check |
| Appointments | Time first, then the person, mode icon (video or clinic) and status |
| Documents | Type icon (flask, scan, file), with "Secure: passed the safety check" |
| Prescriptions | A signed slip with a green border and seal icon; drafts dashed |
| Timeline | A vertical rail with an icon per event and a provenance badge (patient reported, doctor reported, verified) |
| Privacy and consent | Shield icons, "Shared until …", and lock icons where nothing is shared |
| Relationships | The bridge motif: you and your doctor joined by an arc, on the landing page |

## Icons

One library only, **lucide-react**, at 16px (`h-4 w-4`) inline and 20px in navigation. Health icons are used where they carry meaning, never as decoration.

## Tables

Tables are used only where comparison helps: admin users, the audit log and queues. Patient-facing views use lists, cards and timelines. On phones, tables keep the primary action visible without sideways scrolling.
