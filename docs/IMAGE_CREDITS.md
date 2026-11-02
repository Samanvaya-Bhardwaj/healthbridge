# Image credits

The photos in `frontend/src/assets/care/` come from [Pexels](https://www.pexels.com) under the [Pexels licence](https://www.pexels.com/license/). It allows use in apps and websites, and editing. Attribution is not required, but these photographers deserve the credit: each page below names its photographer.

The licence has limits that shape how the photos are used here:

- **No implied endorsement.** The people shown are models. They are not HealthBridge doctors or patients and do not endorse it, so a photo never appears beside a doctor's name or as someone's profile picture.
- **No one in a bad light.** Photos show people well and at ease: no distress, no hospital beds.
- **No redistribution as stock.** The photos ship inside this app, cropped and compressed. They are not offered as a collection for others to download.

| File | Shows | Used on | Source |
|---|---|---|---|
| `welcome.webp` | A doctor listening to an older patient | Landing page, tour invitation and first step | [Pexels 39192358](https://www.pexels.com/photo/doctor-consulting-with-older-patient-in-office-39192358/) |
| `doctors.webp` | A doctor at her desk | My Doctors, home tile, landing page | [Pexels 8376277](https://www.pexels.com/photo/woman-in-white-scrub-suit-wearing-black-stethoscope-8376277/) |
| `visit.webp` | A doctor talking with a patient | Appointments | [Pexels 7579831](https://www.pexels.com/photo/a-doctor-talking-the-patient-7579831/) |
| `online.webp` | A video call with a doctor on a tablet | Home tile, landing page | [Pexels 8376171](https://www.pexels.com/photo/high-angle-shot-of-a-person-making-a-zoom-call-to-a-doctor-8376171/) |
| `assistant.webp` | An older woman with her phone | Assistant, home tile | [Pexels 8834082](https://www.pexels.com/photo/elderly-woman-holding-phone-looking-at-the-camera-8834082/) |
| `reports.webp` | A printed report on a clipboard | Health Records, home tile | [Pexels 7578802](https://www.pexels.com/photo/hands-of-doctor-holding-notepad-and-pen-7578802/) |
| `medicines.webp` | An older person sorting medicines | Prescriptions, home tile, landing page | [Pexels 8088898](https://www.pexels.com/photo/person-organizing-his-medicines-8088898/) |
| `checkin.webp` | An older man talking on the phone | Follow-ups, home tile | [Pexels 7870684](https://www.pexels.com/photo/photo-of-an-old-man-happily-talking-on-the-phone-7870684/) |
| `tablet.webp` | An older woman using a tablet | Sign-in panel, landing page | [Pexels 5231330](https://www.pexels.com/photo/elderly-happy-woman-making-video-call-online-on-modern-tablet-5231330/) |

## Adding a photo

- Use a source whose licence you have read, and add a row here.
- Host it in the app, never from a remote URL: the Content Security Policy allows only our own images, and patients' browsers should not call a third party.
- Crop to 3:2. Save as WebP at about 720×480 (1200×800 for a hero) and quality 74, which keeps most photos under 30 KB. Saving a new image also drops the original's metadata.
- Use `alt=""` when the text beside it says what it means. Most photos here are decorative.
- Avoid candid portraits of real people. A staged photo of a model is the right choice for a health app, because nobody is shown as a patient without having agreed to it.
