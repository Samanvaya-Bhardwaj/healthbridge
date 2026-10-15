import { createHash } from 'node:crypto';
import { withActor } from '../../src/core/db/actorContext.js';

/**
 * Step 11: synthetic clinical history for the main demo patients, created through the real
 * services (same validation, authorisation, RLS, audit and immutability as the app), so the
 * records, timeline, prescriptions, follow-ups, assistant and doctor journeys have content.
 *
 * Past visits need a past "now": the services read time from an injected clock, so a
 * second container runs on a shifted clock while each visit happens, then returns to the
 * present. Audit rows and outbox events keep their real (database) time.
 *
 * Asha Rao with Dr. Meera Iyer (online): three visits about blood sugar over ~10 weeks, each
 * with a signed SOAP note and a signed prescription (one corrected); two answered and
 * closed check-ins and one still to come. Kamala Rao (Asha's dependent): a blood-pressure
 * review that asks for an in-clinic visit, then that visit booked and paid (fake provider).
 * Lab reports (synthetic PDFs with a text layer) uploaded for both, for scanning and, with
 * Asha's opt-in, AI extraction by the worker.
 *
 * Idempotent: skipped when the visits or documents already exist.
 */

const DAY = 86_400_000;
const IST_OFFSET_MIN = 330;
const isoDay = (date) =>
  new Date(date.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
/** Minutes after midnight, India time. */
const istMinutes = (iso) => {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
/** A moment on a given India-time day (e.g. 10:00). */
const istAt = (day, hh, mm = 0) =>
  new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);

// ── A minimal one-page PDF with a text layer (same layout as the AI service's tests) ──
function syntheticPdf(lines) {
  const esc = (l) => l.replace(/[()\\]/g, (c) => String.fromCharCode(92) + c);
  const text = lines.map((l) => `(${esc(l)}) Tj`).join(' T* ');
  const stream = Buffer.from(`BT /F1 11 Tf 50 750 Td 14 TL ${text} ET`, 'latin1');
  const objects = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>'),
    Buffer.from(
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    ),
    Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'),
    Buffer.concat([
      Buffer.from(`<</Length ${stream.length}>>stream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  let size = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${size}\n%%EOF\n`,
  ].join('');
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

const LAB_REPORTS = {
  ashaCbc: {
    title: 'Complete blood count (synthetic)',
    filename: 'cbc-synthetic.pdf',
    lines: (day) => [
      'Sunrise Diagnostics Laboratory, Pune (SYNTHETIC)',
      `Report date: ${day}`,
      'Patient: Asha Rao (TEST DATA)',
      'Complete Blood Count',
      'Hemoglobin: 12.8 g/dL (ref 12.0-15.5)',
      'WBC: 7.2 10^3/uL (ref 4.0-11.0)',
      'Platelets: 265 10^3/uL (ref 150-450)',
    ],
  },
  ashaSugar: {
    title: 'Blood sugar and HbA1c (synthetic)',
    filename: 'hba1c-synthetic.pdf',
    lines: (day) => [
      'Sunrise Diagnostics Laboratory, Pune (SYNTHETIC)',
      `Report date: ${day}`,
      'Patient: Asha Rao (TEST DATA)',
      'Diabetes Panel',
      'Fasting Glucose: 118 mg/dL (ref 70-99)',
      'HbA1c: 6.4 % (ref 4.0-5.6)',
    ],
  },
  kamalaLipids: {
    title: 'Lipid profile (synthetic)',
    filename: 'lipids-synthetic.pdf',
    lines: (day) => [
      'Sunrise Diagnostics Laboratory, Pune (SYNTHETIC)',
      `Report date: ${day}`,
      'Patient: Kamala Rao (TEST DATA)',
      'Lipid Profile',
      'Total Cholesterol: 212 mg/dL (ref 0-200)',
      'LDL Cholesterol: 138 mg/dL (ref 0-130)',
      'HDL Cholesterol: 48 mg/dL (ref 40-60)',
    ],
  },
};

const METFORMIN = {
  drugName: 'Metformin',
  strength: '500 mg',
  form: 'tablet',
  route: 'oral',
};

/** Asha's visits: days before today, the note, the prescription and the check-in. */
const ASHA_VISITS = [
  {
    daysAgo: 74,
    reason: 'Synthetic demo: high fasting sugar on home readings',
    note: {
      subjective:
        'Synthetic: home fasting readings 115-130 mg/dL for three weeks. No thirst or weight loss.',
      objective: 'Synthetic: well on video. Reported weight 68 kg.',
      assessment: 'Synthetic: raised fasting glucose, likely early type 2 diabetes.',
      plan: 'Synthetic: start metformin, diet and walking plan, HbA1c in 8 weeks.',
    },
    items: [
      {
        ...METFORMIN,
        dose: '1 tablet',
        frequency: 'once daily after dinner',
        duration: '30 days',
        instructions: 'Take with food.',
      },
    ],
    advice: 'Synthetic: 30 minutes of walking daily; reduce sugary drinks.',
    followUp: { afterDays: 14, overall: 'better', note: 'Readings are a little lower.' },
  },
  {
    daysAgo: 40,
    reason: 'Synthetic demo: diabetes review',
    note: {
      subjective: 'Synthetic: tolerating metformin; fasting readings 105-115 mg/dL.',
      objective: 'Synthetic: no side effects reported.',
      assessment: 'Synthetic: improving control; low vitamin D on outside report.',
      plan: 'Synthetic: increase metformin to twice daily; vitamin D3 weekly.',
    },
    items: [
      {
        ...METFORMIN,
        dose: '1 tablet',
        frequency: 'twice daily after meals',
        duration: '60 days',
        instructions: '',
      },
      {
        drugName: 'Cholecalciferol (Vitamin D3)',
        strength: '60000 IU',
        form: 'capsule',
        dose: '1 capsule',
        frequency: 'once a week',
        route: 'oral',
        duration: '8 weeks',
        instructions: 'With milk, same day each week.',
      },
    ],
    correction: {
      reason: 'Synthetic: corrected the vitamin D duration to 6 weeks.',
      duration: '6 weeks',
    },
    advice: 'Synthetic: continue diet plan.',
    followUp: { afterDays: 21, overall: 'same', note: 'Mild stomach upset in the first week.' },
  },
  {
    daysAgo: 11,
    reason: 'Synthetic demo: HbA1c results',
    note: {
      subjective: 'Synthetic: reviewing HbA1c report. Feeling well.',
      objective: 'Synthetic: HbA1c 6.4 % on the uploaded report.',
      assessment: 'Synthetic: type 2 diabetes, improving on metformin.',
      plan: 'Synthetic: continue metformin; repeat HbA1c in 3 months.',
    },
    items: [
      {
        ...METFORMIN,
        dose: '1 tablet',
        frequency: 'twice daily after meals',
        duration: '90 days',
        instructions: 'Do not skip meals.',
      },
    ],
    advice: 'Synthetic: keep the home readings log.',
    followUp: { afterDays: 16 }, // still to come
  },
];

const KAMALA_VISIT = {
  daysAgo: 19,
  reason: 'Synthetic demo: blood pressure review',
  note: {
    subjective: 'Synthetic: home BP readings around 150/92 for two weeks. Occasional headache.',
    objective: 'Synthetic: on video, alert and comfortable.',
    assessment: 'Synthetic: raised blood pressure; needs an in-person check and ECG.',
    plan: 'Synthetic: start amlodipine; book an in-clinic visit.',
  },
  items: [
    {
      drugName: 'Amlodipine',
      strength: '5 mg',
      form: 'tablet',
      dose: '1 tablet',
      frequency: 'once daily in the morning',
      route: 'oral',
      duration: '30 days',
      instructions: 'Keep a BP diary.',
    },
  ],
  advice: 'Synthetic: less salt; record BP twice a day.',
  outcome: {
    outcome: 'physical_visit_required',
    visitNote: 'Synthetic: please book an in-clinic visit for a BP check and ECG.',
  },
};

/**
 * @param {{ makeContainer: (now: () => Date) => object, live: object,
 *   knex: import('knex').Knex, principalFor: Function, ids: Record<string, string>,
 *   ashaProfile: object, clinic: object, log: Function }} deps
 */
export async function seedHistory({
  makeContainer,
  live,
  knex,
  principalFor,
  ids,
  ashaProfile,
  clinic,
  log,
}) {
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const travelTo = (at) => {
    offsetMs = at.getTime() - Date.now();
  };
  const svc = makeContainer(clock);
  const asha = await principalFor(ids['patient.asha']);
  const meeraUser = ids['dr.meera'];
  const meeraDoctor = await live.repositories.doctors.findByUserId(meeraUser);
  let meera = await principalFor(meeraUser);
  const today = new Date();

  const kamala = (await live.patientService.listDependents(asha)).find(
    (d) => d.fullName === 'Kamala Rao',
  );

  try {
    // ── Kamala joins Dr. Meera's care (managed by Asha) ─────────────────────────────
    if (kamala) {
      const care = await live.careService.listForPatient(asha, kamala.id);
      if (!care.some((r) => r.doctorId === meeraDoctor.id && r.status === 'active')) {
        const req = await live.careService.request(asha, {
          patientId: kamala.id,
          doctorId: meeraDoctor.id,
          clinicId: clinic.id,
        });
        await live.careService.act(meera, req.id, 'accept');
        log('kamala → dr.meera care accepted');
      }
    }

    const past = await live.appointmentService.listForPatient(asha, {
      patientId: ashaProfile.id,
      scope: 'past',
    });
    if (past.some((a) => a.status === 'completed')) {
      log('clinical history: already present');
    } else {
      // A past online schedule (13:00-14:00 India time, Mon-Sat) that ends yesterday, so it
      // never overlaps today's schedule. Created "back then".
      const firstDay = new Date(today.getTime() - 90 * DAY);
      travelTo(istAt(isoDay(firstDay), 8));
      meera = await principalFor(meeraUser);
      const pastRules = (await svc.availabilityService.listRules(meera)).filter(
        (r) => r.mode === 'online' && r.validUntil && r.startTime.startsWith('13:00'),
      );
      for (const weekday of [1, 2, 3, 4, 5, 6]) {
        if (pastRules.some((r) => r.weekday === weekday)) continue;
        await svc.availabilityService.createRule(meera, {
          mode: 'online',
          weekday,
          startTime: '13:00',
          endTime: '14:00',
          slotMinutes: 20,
          timezone: 'Asia/Kolkata',
          validFrom: isoDay(firstDay),
          validUntil: isoDay(new Date(today.getTime() - DAY)),
          feePaise: 0,
        });
      }
      log('dr.meera past schedule created');

      for (const visit of ASHA_VISITS) {
        await pastVisit(ashaProfile.id, visit);
      }
      if (kamala) await pastVisit(kamala.id, KAMALA_VISIT);
      offsetMs = 0;
      log('clinical history created', { visits: ASHA_VISITS.length + (kamala ? 1 : 0) });
    }
    offsetMs = 0;

    // ── Kamala's in-clinic visit, booked and paid (fake provider) ────────────────────
    if (kamala) {
      const upcoming = await live.appointmentService.listForPatient(asha, {
        patientId: kamala.id,
        scope: 'upcoming',
      });
      if (!upcoming.some((a) => a.mode === 'in_clinic')) {
        const [slot] = await live.availabilityService.slots(asha, meeraDoctor.id, {
          from: isoDay(new Date(today.getTime() + 2 * DAY)),
          to: isoDay(new Date(today.getTime() + 9 * DAY)),
          mode: 'in_clinic',
        });
        if (slot) {
          const { appointment: appt } = await live.appointmentService.book(asha, {
            patientId: kamala.id,
            doctorId: meeraDoctor.id,
            startsAt: slot.startsAt,
            mode: 'in_clinic',
            clinicId: slot.clinicId,
            reason: 'Synthetic demo: BP check and ECG, as Dr. Meera asked',
          });
          await live.paymentService.checkout(asha, appt.id);
          await live.paymentService.simulate(asha, appt.id, { outcome: 'success' });
          log('kamala in-clinic visit booked and paid', { startsAt: slot.startsAt });
        }
      }
    }

    // ── Lab reports (synthetic PDFs) ─────────────────────────────────────────────────
    await uploadReport(ashaProfile.id, LAB_REPORTS.ashaCbc, 60);
    await uploadReport(ashaProfile.id, LAB_REPORTS.ashaSugar, 13);
    if (kamala) await uploadReport(kamala.id, LAB_REPORTS.kamalaLipids, 21);
  } finally {
    offsetMs = 0;
  }

  /** One online visit with Dr. Meera, from booking to outcome and check-in. */
  async function pastVisit(patientId, visit) {
    // Book the day before, at 10:00, for the first free 13:xx slot on or after the day.
    const target = new Date(today.getTime() - visit.daysAgo * DAY);
    travelTo(istAt(isoDay(new Date(target.getTime() - DAY)), 10));
    const weekEnd = new Date(target.getTime() + 7 * DAY);
    const inWindow = (iso) =>
      istMinutes(iso) >= 13 * 60 &&
      istMinutes(iso) < 14 * 60 &&
      new Date(iso) >= istAt(isoDay(target), 0) &&
      new Date(iso) < weekEnd;
    // Resumable: a visit booked by an interrupted earlier run is carried on.
    let appt = (
      await svc.appointmentService.listForPatient(asha, { patientId, scope: 'past' })
    ).find((a) => a.doctorId === meeraDoctor.id && inWindow(a.startsAt));
    if (appt?.status === 'completed') return;
    let slot = appt ? { startsAt: new Date(appt.startsAt).toISOString() } : null;
    if (!appt) {
      const slots = await svc.availabilityService.slots(asha, meeraDoctor.id, {
        from: isoDay(target),
        to: isoDay(new Date(target.getTime() + 6 * DAY)),
        mode: 'online',
      });
      slot = slots.find((s) => inWindow(s.startsAt));
      if (!slot) throw new Error(`no past slot near ${isoDay(target)}`);
      ({ appointment: appt } = await svc.appointmentService.book(asha, {
        patientId,
        doctorId: meeraDoctor.id,
        startsAt: slot.startsAt,
        mode: 'online',
        reason: visit.reason,
      }));
    }

    const startsAt = new Date(slot.startsAt);
    travelTo(new Date(startsAt.getTime() - 5 * 60_000));
    meera = await principalFor(meeraUser);
    const started = await svc.consultationService.start(meera, appt.id);
    await svc.consultationService.saveNote(meera, appt.id, visit.note);
    await svc.consultationService.signNote(meera, appt.id);
    const draft = await svc.prescriptionService.saveDraft(meera, appt.id, {
      items: visit.items,
      advice: visit.advice,
    });
    const signed = await svc.prescriptionService.sign(meera, draft.id);
    if (visit.correction) {
      travelTo(new Date(startsAt.getTime() + 8 * 60_000));
      await svc.prescriptionService.correct(meera, signed.id, {
        items: visit.items.map((i) =>
          i.drugName.startsWith('Cholecalciferol')
            ? { ...i, duration: visit.correction.duration }
            : i,
        ),
        advice: visit.advice,
        reason: visit.correction.reason,
      });
    }
    travelTo(new Date(startsAt.getTime() + 12 * 60_000));
    const followUpOn = visit.followUp
      ? isoDay(new Date(startsAt.getTime() + visit.followUp.afterDays * DAY))
      : undefined;
    await svc.consultationService.recordOutcome(
      meera,
      appt.id,
      visit.outcome ?? { outcome: 'online_managed', ...(followUpOn ? { followUpOn } : {}) },
    );

    if (visit.followUp) {
      // The worker would create it from the outbox event too (idempotent per consultation).
      const created = await svc.followUpService.createFromOutcome({
        aggregateId: started.consultation.id,
        payload: { outcome: 'online_managed', followUpOn },
      });
      if (visit.followUp.overall && created.followUpId) {
        travelTo(istAt(followUpOn, 9, 30));
        await svc.followUpService.respond(asha, created.followUpId, {
          overall: visit.followUp.overall,
          redFlags: [],
          note: `Synthetic: ${visit.followUp.note}`,
        });
        travelTo(istAt(followUpOn, 18));
        meera = await principalFor(meeraUser);
        await svc.followUpService.close(meera, created.followUpId, {
          note: 'Synthetic: reviewed; continue the plan.',
        });
      }
    }
    log('past visit', {
      day: isoDay(startsAt),
      patient: patientId === ashaProfile.id ? 'asha' : 'kamala',
    });
  }

  /** Upload intent → object → complete; the worker scans, promotes and (with opt-in) analyses. */
  async function uploadReport(patientId, report, daysAgo) {
    const existing = await live.documentService.list(asha, patientId);
    if (existing.some((d) => d.title === report.title)) return;
    const content = syntheticPdf(report.lines(isoDay(new Date(today.getTime() - daysAgo * DAY))));
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { document } = await live.documentService.createUploadIntent(asha, patientId, {
      documentType: 'lab_report',
      title: report.title,
      filename: report.filename,
      contentType: 'application/pdf',
      sizeBytes: content.length,
      sha256,
    });
    // The key is random and server-generated; the uploader can read it on their own row.
    const { quarantine_key: key } = await withActor(knex, asha.userId, (trx) =>
      trx('medical_documents').where({ id: document.id }).first('quarantine_key'),
    );
    await live.documentStorage.putObject(key, content, { contentType: 'application/pdf', sha256 });
    await live.documentService.complete(asha, document.id);
    log('lab report uploaded', { title: report.title });
  }
}
