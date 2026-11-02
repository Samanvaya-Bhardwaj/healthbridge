# ADR-0042: The patient side in pictures, larger text and a guided tour

- **Status:** Accepted (implemented).
- **Date:** 2026-10-31
- **Amends:** the visual identity's "no photography" rule ([VISUAL_IDENTITY.md](../VISUAL_IDENTITY.md)).

## Context

The patient side was mostly text: lists of rows, long page descriptions and small labels.
That is hard for older patients, who are the people HealthBridge most wants to serve. They
need to recognise where to go, read comfortably, and be shown how the app works once.

## Decision

1. **Photos, hosted in the app.** Stock photos from Pexels, cropped and compressed to about
   20 KB each, are bundled by Vite. They are never loaded from a remote URL. The licence
   and its limits are in [IMAGE_CREDITS.md](../IMAGE_CREDITS.md).
2. **Six picture tiles on the home page.** "What would you like to do?" replaces the "Your
   care" list: a photo, a name and one short line each. On a phone they become rows with
   the photo beside the words, so all six fit on about one screen.
3. **A photo and one plain sentence on each patient page**, through `PageHeader`'s `image`.
   Doctors' and administrators' pages stay without photos: they are dense on purpose.
4. **Photos are decorative** (`alt=""`). The words beside them say what they mean, so a
   screen reader isn't told twice. Text never sits on a photo, which keeps contrast
   predictable.
5. **A "Larger text" switch** in the patient header sets the root font size, and everything
   is sized in rem. It is saved on the device.
6. **A guided tour, offered and never forced.** A card on the home page invites the person,
   and "Not now" puts it away. A pop-up on arrival could startle someone and would hide the
   page they came for. The tour is ten steps, one idea each, in large type. It lights up
   the real tile, keeps its card clear of it, and never navigates or presses anything for
   the person. "Show me around" stays on the home page afterwards.
7. **The tour reuses `Dialog`,** with a `guide` mode, instead of adding a tour library. That
   keeps the focus trap, Escape and focus return already tested there, and adds no
   dependency. Focus stays on Next, because Back disappears on the first step.
8. **What's seen is saved per person on the device** (`localStorage`). If storage is blocked,
   the tour is simply offered again, and the app works the same.

## Consequences

- Patients can find their way by picture, and the home page has far fewer words.
- The photos show models from stock libraries. Few show Indian patients and doctors in
  clinical settings, so the set should be replaced with photos of the app's real audience
  when a budget allows. Nobody in them is a HealthBridge doctor or patient.
- Someone who changes device sees the invitation again. That's harmless, and it avoids a
  migration and a server-side record for a convenience.
- The tour describes the home page only. It doesn't walk through booking itself.

## Alternatives considered

- **A tour library (react-joyride, driver.js):** quicker to start, but it brings its own
  focus handling and styling, and a dependency to review. The tour needs little beyond
  what `Dialog` already does.
- **Starting the tour automatically on first sign-in:** blocks the page and the browser
  journeys, and can confuse someone who came to do one thing.
- **Icons instead of photos:** the app already has icons, and they were part of the problem:
  a photo of a tablet with a doctor on it says "online visit" without any reading.
- **Candid portraits of Indian elders:** the closest match to the audience, but they show
  real people as patients without their agreement. Rejected (IMAGE_CREDITS.md).
