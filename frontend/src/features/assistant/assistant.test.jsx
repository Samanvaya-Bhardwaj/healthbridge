import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { App } from '../../app/App.jsx';
import { routes } from '../../app/routes.jsx';
import { createQueryClient } from '../../lib/queryClient.js';
import { setAccessToken } from '../../lib/apiClient.js';
import {
  clearCookies,
  fakeApi,
  json,
  makeUser,
  problem,
  sessionPayload,
  setCookie,
} from '../../../tests/fakeApi.js';

const PATIENT = '0192b6f0-0000-7000-8000-0000000000a7';
const SESSION = '0192b6f0-0000-7000-8000-0000000000b1';
const DOCTOR = '0192b6f0-0000-7000-8000-0000000000d1';
const NEW_DOCTOR = '0192b6f0-0000-7000-8000-0000000000d2';

const sessionView = (version = 1) => ({
  id: SESSION,
  patientId: PATIENT,
  actingFor: 'self',
  status: 'active',
  version,
  turns: version - 1,
  expiresAt: '2026-10-10T05:00:00Z',
});
const doctor = (id, name, careStatus, reasons = []) => ({
  type: 'doctor',
  careStatus,
  doctor: {
    id,
    professionalName: name,
    primarySpecialization: 'Dermatology',
    languages: ['English', 'Hindi'],
    yearsOfExperience: 9,
    clinics: [],
    reasons,
  },
});

function signedIn(routesMap) {
  setCookie('hb_csrf=csrf-1; path=/');
  const user = makeUser(['PATIENT']);
  return fakeApi({
    'POST /api/v1/auth/refresh': () => json(200, sessionPayload(user)),
    'GET /api/v1/auth/me': () => json(200, { data: user }),
    'GET /api/v1/notifications/unread-count': () => json(200, { data: { unreadCount: 0 } }),
    'GET /api/v1/patients/me': () => json(200, { data: { id: PATIENT, fullName: 'Asha Rao' } }),
    'GET /api/v1/patients/me/dependents': () => json(200, { data: [] }),
    'POST /api/v1/assistant/sessions': () => json(201, { data: sessionView(1) }),
    ...routesMap,
  });
}
const open = (path) =>
  render(
    <App
      router={createMemoryRouter(routes, { initialEntries: [path] })}
      queryClient={createQueryClient()}
    />,
  );

beforeEach(() => {
  clearCookies();
  setAccessToken(null);
});
afterEach(() => clearCookies());

describe('HealthBridge Assistant', () => {
  it('shows grounded suggestions as AI, separate from anything booked', async () => {
    const calls = signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () =>
        json(200, {
          data: {
            session: sessionView(2),
            reply: {
              kind: 'answer',
              message: 'Here are 2 verified doctors who match.',
              source: 'ai_assistant',
              cards: [
                doctor(DOCTOR, 'Dr. Meera Iyer', 'active'),
                doctor(NEW_DOCTOR, 'Dr. New', 'none', [
                  { code: 'specialty', value: 'Dermatology' },
                  { code: 'area', value: 'Acne' },
                  { code: 'city', value: 'Pune' },
                  { code: 'mode', value: 'online' },
                  { code: 'care_team', value: null },
                ]),
                {
                  type: 'slot',
                  doctorId: DOCTOR,
                  doctorName: 'Dr. Meera Iyer',
                  startsAt: '2026-10-10T13:00:00Z',
                  mode: 'online',
                  feePaise: null,
                  patientId: PATIENT,
                  bookable: true,
                },
              ],
            },
            understood: {
              intent: 'find_doctor',
              criteria: { specialty: 'Dermatology', date: '2026-10-10', timeWindow: 'evening' },
            },
            degraded: false,
          },
        }),
    });
    open('/app/assistant');
    await userEvent.click(await screen.findByRole('button', { name: 'Find a doctor' }));

    expect(await screen.findByText('Here are 2 verified doctors who match.')).toBeInTheDocument();
    expect(screen.getByText('AI suggestion')).toBeInTheDocument();
    expect(screen.getByText('Suggested · not booked')).toBeInTheDocument();
    expect(screen.getByText(/What I understood:/).closest('p')).toHaveTextContent('Dermatology');
    expect(screen.getByText('In your care team')).toBeInTheDocument();
    expect(screen.getByText('Not in your care team yet')).toBeInTheDocument();
    // Why each doctor was suggested, from the backend's reasons only.
    expect(
      screen.getByText(
        'Why suggested: Dermatology · Lists Acne · Practises in Pune · Online consultations',
      ),
    ).toBeInTheDocument();
    // ADR-0038: booking continues in the conversation; nothing is booked by a suggestion.
    expect(screen.getAllByRole('button', { name: 'Book' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /choose this time/ })).toBeInTheDocument();

    const sent = calls.find((c) => c.key.endsWith('/messages'));
    expect(JSON.parse(sent.init.body)).toMatchObject({
      text: 'I would like to find a doctor',
      version: 1,
    });
  });

  it('shows emergency guidance and degraded answers distinctly', async () => {
    let n = 0;
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () => {
        n += 1;
        return json(200, {
          data: {
            session: sessionView(n + 1),
            reply:
              n === 1
                ? {
                    kind: 'emergency',
                    message: 'If this might be an emergency, call 112 or 108 now.',
                    cards: [],
                  }
                : {
                    kind: 'fallback',
                    message: 'The assistant isn’t available right now.',
                    cards: [{ type: 'link', target: 'my_doctors' }],
                  },
            understood: { intent: null, criteria: {} },
            degraded: n !== 1,
          },
        });
      },
    });
    open('/app/assistant');
    const box = await screen.findByLabelText('Your message');
    await userEvent.type(box, 'I have chest pain{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This might be an emergency');
    expect(within(alert).getByRole('link', { name: 'Call 112' })).toHaveAttribute(
      'href',
      'tel:112',
    );

    await userEvent.type(box, 'a doctor please{Enter}');
    expect(await screen.findByText('I couldn’t help with that just now')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open My Doctors' })).toBeInTheDocument();
  });

  it('shows facts from the record apart from AI suggestions (step 10)', async () => {
    let n = 0;
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () => {
        n += 1;
        const cards =
          n === 1
            ? [
                {
                  type: 'appointment',
                  source: 'record',
                  appointmentId: '0192b6f0-0000-7000-8000-0000000000c1',
                  reference: '000000C1',
                  doctorName: 'Dr. Meera Iyer',
                  startsAt: '2026-10-20T05:00:00Z',
                  mode: 'online',
                  status: 'confirmed',
                },
                { type: 'link', target: 'appointments' },
              ]
            : [
                {
                  type: 'medication',
                  source: 'record',
                  prescriptionId: '0192b6f0-0000-7000-8000-0000000000e1',
                  reference: 'RX-1',
                  doctorName: 'Dr. Meera Iyer',
                  signedAt: '2026-10-10T05:00:00Z',
                  items: [
                    {
                      drugName: 'Cetirizine',
                      strength: '10 mg',
                      form: 'tablet',
                      dose: '1 tablet',
                      frequency: 'once daily',
                      route: 'oral',
                      duration: '5 days',
                      instructions: 'At night',
                    },
                  ],
                },
                { type: 'link', target: 'prescriptions' },
              ];
        return json(200, {
          data: {
            session: sessionView(n + 1),
            reply: {
              kind: 'not_yet',
              message:
                n === 1
                  ? "I can't change appointments here yet. Open the appointment from the Appointments page to reschedule or cancel it."
                  : 'Signed prescriptions, with how to take each medicine, are on the Prescriptions page.',
              cards,
            },
            understood: { intent: n === 1 ? 'reschedule' : 'view_medications', criteria: {} },
            degraded: false,
          },
        });
      },
    });
    open('/app/assistant');
    const box = await screen.findByLabelText('Your message');
    await userEvent.type(box, 'I need to reschedule{Enter}');
    const upcoming = await screen.findByRole('region', { name: 'Upcoming appointments' });
    expect(within(upcoming).getByText('From your records')).toBeInTheDocument();
    expect(within(upcoming).getByText('Dr. Meera Iyer')).toBeInTheDocument();
    expect(within(upcoming).getByRole('link', { name: 'Open appointment' })).toHaveAttribute(
      'href',
      '/app/appointments/0192b6f0-0000-7000-8000-0000000000c1',
    );

    await userEvent.type(box, 'what medicines do I take{Enter}');
    const medicines = await screen.findByRole('region', {
      name: 'Medicines on your recent prescriptions',
    });
    expect(within(medicines).getByText(/Cetirizine 10 mg \(tablet\)/)).toBeInTheDocument();
    expect(
      within(medicines).getByText(/1 tablet, once daily, oral, for 5 days/),
    ).toBeInTheDocument();
    expect(within(medicines).getByText(/Ask your doctor before changing/)).toBeInTheDocument();
    // The AI's own words stay labelled as such.
    expect(screen.getAllByText('AI suggestion').length).toBeGreaterThanOrEqual(2);
  });

  it('books in the conversation: doctor, time, confirm, pay, calendar (ADR-0038)', async () => {
    const APPT = '0192b6f0-0000-7000-8000-0000000000c9';
    const ACTION = '0192b6f0-0000-7000-8000-0000000000aa';
    const START = '2026-10-12T05:00:00Z';
    let turn = 0;
    let paid = false;
    const sent = [];
    const appointment = () => ({
      id: APPT,
      reference: '000000C9',
      status: paid ? 'confirmed' : 'pending_payment',
      paymentStatus: paid ? 'paid' : 'pending',
      mode: 'online',
      startsAt: START,
      endsAt: '2026-10-12T05:15:00Z',
      feePaise: 50_000,
      holdExpiresAt: '2026-10-11T10:00:00Z',
      doctor: { id: DOCTOR, professionalName: 'Dr. Meera Iyer' },
    });
    const calls = signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: (init) => {
        turn += 1;
        sent.push(JSON.parse(init.body));
        const replies = [
          {
            kind: 'answer',
            message: 'Here is 1 verified doctor.',
            cards: [doctor(DOCTOR, 'Dr. Meera Iyer', 'active')],
          },
          {
            kind: 'clarify',
            message: 'Here are the free times. Which time suits you?',
            cards: [
              {
                type: 'slot',
                doctorId: DOCTOR,
                doctorName: 'Dr. Meera Iyer',
                startsAt: START,
                mode: 'online',
                feePaise: 50_000,
                patientId: PATIENT,
                bookable: true,
              },
            ],
          },
          {
            kind: 'confirm',
            message: "Here's the booking. Check the details, then tap Confirm booking.",
            cards: [
              {
                type: 'booking',
                actionId: ACTION,
                doctor: {
                  id: DOCTOR,
                  professionalName: 'Dr. Meera Iyer',
                  primarySpecialization: 'General Medicine',
                },
                startsAt: START,
                endsAt: '2026-10-12T05:15:00Z',
                mode: 'online',
                clinic: null,
                feePaise: 50_000,
                careStatus: 'active',
                joinsCareTeam: false,
                acceptsNewPatients: false,
              },
            ],
          },
        ];
        return json(200, {
          data: {
            session: sessionView(turn + 1),
            reply: { ...replies[turn - 1], source: 'ai_assistant' },
            understood: { intent: 'book_appointment', criteria: {} },
            degraded: false,
          },
        });
      },
      [`POST /api/v1/assistant/sessions/${SESSION}/actions/${ACTION}/confirm`]: () =>
        json(200, {
          data: {
            id: ACTION,
            status: 'done',
            appointmentId: APPT,
            appointmentStatus: 'pending_payment',
          },
        }),
      [`GET /api/v1/appointments/${APPT}`]: () => json(200, { data: appointment() }),
      [`POST /api/v1/appointments/${APPT}/payment`]: () =>
        json(200, {
          data: { payment: { id: 'p1', amountPaise: 50_000 }, checkout: { provider: 'fake' } },
        }),
      [`POST /api/v1/appointments/${APPT}/payment/simulate`]: () => {
        paid = true;
        return json(200, { data: { status: 'processing' } });
      },
    });
    open('/app/assistant');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Book an appointment' }));
    await user.click(await screen.findByRole('button', { name: 'Book' }));
    await user.click(await screen.findByRole('button', { name: /choose this time/ }));
    expect(sent[1].select).toEqual({ kind: 'doctor', doctorId: DOCTOR });
    expect(sent[2].select).toEqual({ kind: 'slot', doctorId: DOCTOR, startsAt: START });

    const booking = await screen.findByRole('region', { name: 'Booking to confirm' });
    expect(within(booking).getByText('Not booked yet')).toBeInTheDocument();
    const confirm = within(booking).getByRole('button', { name: 'Confirm booking' });
    expect(confirm).toBeDisabled(); // the reason for the visit comes first
    await user.type(
      within(booking).getByLabelText('Reason for the visit'),
      'Synthetic: sugar review',
    );
    await user.click(confirm);
    const confirmCall = calls.find((c) => c.key.endsWith('/confirm'));
    expect(JSON.parse(confirmCall.init.body)).toEqual({ reason: 'Synthetic: sugar review' });

    const pay = await screen.findByRole('region', { name: 'Payment' });
    await user.click(within(pay).getByRole('button', { name: /^Pay / }));
    await user.click(await screen.findByRole('button', { name: /test payment/ }));
    const done = await screen.findByRole('region', { name: 'Booked' }, { timeout: 8000 });
    expect(within(done).getByText(/Booked and paid/)).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: /Google Calendar/ })).toBeInTheDocument();
    expect(within(done).getByRole('button', { name: /Download .ics/ })).toBeInTheDocument();
  });

  it('answers questions about the documents with sources, labelled as AI (Part 4)', async () => {
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () =>
        json(200, {
          data: {
            session: sessionView(2),
            reply: {
              kind: 'answer',
              message:
                'From your documents. This is an AI summary with its sources, not medical advice: ask your doctor about anything that worries you.',
              cards: [
                {
                  type: 'record_answer',
                  source: 'ai_generated',
                  sentences: [
                    {
                      text: 'Your HbA1c fell from 6.4 % to 6.1 %.',
                      citations: [{ label: 'S1', type: 'document', title: 'HbA1c report' }],
                    },
                  ],
                },
                { type: 'link', target: 'records' },
              ],
            },
            understood: { intent: 'ask_records', criteria: {} },
            degraded: false,
          },
        }),
    });
    open('/app/assistant');
    const box = await screen.findByLabelText('Your message');
    await userEvent.type(box, 'how is my HbA1c{Enter}');
    const answer = await screen.findByRole('region', { name: 'Answer from your documents' });
    expect(within(answer).getByText(/Your HbA1c fell from 6.4 % to 6.1 %/)).toBeInTheDocument();
    expect(within(answer).getByText('S1 · HbA1c report')).toBeInTheDocument();
    expect(within(answer).getByText(/AI summary of your documents/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Health Records' })).toHaveAttribute(
      'href',
      '/app/records',
    );
  });

  it('shows general information from the health library before the doctors (ADR-0040)', async () => {
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () =>
        json(200, {
          data: {
            session: sessionView(2),
            reply: {
              kind: 'answer',
              message:
                "Here's some general information about acidity and heartburn. A general physician is a good first step.",
              cards: [
                {
                  type: 'health_info',
                  source: 'health_library',
                  title: 'Acidity and heartburn',
                  overview: 'Acidity, or heartburn, is a burning feeling in the chest.',
                  linkedWith: ['Large meals, or eating late at night'],
                  mayHelp: ['Eat smaller meals more often'],
                  seeDoctorIf: ['Remedies from a pharmacy haven’t helped'],
                  urgentIf: ['You vomit blood'],
                  review: { status: 'draft', reviewedBy: null, reviewedOn: null },
                  summary: [
                    {
                      text: 'Acidity is often linked with large meals.',
                      citations: [{ label: 'L2', section: 'often linked with' }],
                    },
                  ],
                },
                doctor(DOCTOR, 'Dr. Meera Iyer', 'active'),
              ],
            },
            understood: { intent: 'find_doctor', criteria: {} },
            degraded: false,
          },
        }),
    });
    open('/app/assistant');
    const box = await screen.findByLabelText('Your message');
    await userEvent.type(box, 'I have acidity for 3 days{Enter}');
    const info = await screen.findByRole('region', {
      name: 'General information: Acidity and heartburn',
    });
    expect(
      within(info).getByText('General health information · not a diagnosis'),
    ).toBeInTheDocument();
    expect(within(info).getByText('AI summary for your message')).toBeInTheDocument();
    expect(within(info).getByText(/often linked with large meals/)).toBeInTheDocument();
    expect(within(info).getByText('Eat smaller meals more often')).toBeInTheDocument();
    expect(within(info).getByRole('note')).toHaveTextContent(/call 112.*You vomit blood/);
    expect(within(info).getByText(/I’m an AI assistant, not a doctor/)).toBeInTheDocument();
    expect(within(info).getByText(/not yet reviewed by a clinician/)).toBeInTheDocument();
    // The doctors follow the information.
    expect(screen.getByText('Dr. Meera Iyer')).toBeInTheDocument();
  });

  it('offers a fresh conversation when the session has ended', async () => {
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: () =>
        problem(409, 'assistant_session_ended', 'This conversation has ended. Start a new one.'),
    });
    open('/app/assistant');
    await userEvent.type(await screen.findByLabelText('Your message'), 'hello{Enter}');
    expect(
      await screen.findByRole('button', { name: 'Start a new conversation' }),
    ).toBeInTheDocument();
  });

  it('asks one question with choices; a tap answers it, and the old question closes', async () => {
    const sent = [];
    let turn = 0;
    signedIn({
      [`POST /api/v1/assistant/sessions/${SESSION}/messages`]: (init) => {
        sent.push(JSON.parse(init.body).text);
        turn += 1;
        return json(200, {
          data:
            turn === 1
              ? {
                  session: sessionView(2),
                  reply: {
                    kind: 'clarify',
                    message: 'Different kinds of doctor see that. Which would you like?',
                    source: 'ai_assistant',
                    cards: [
                      { type: 'choice', value: 'Paediatrics' },
                      { type: 'choice', value: 'Neurology' },
                      { type: 'choice', value: 'Any kind of doctor is fine' },
                    ],
                  },
                  understood: { intent: 'find_doctor', criteria: {} },
                  degraded: false,
                }
              : {
                  session: sessionView(3),
                  reply: {
                    kind: 'answer',
                    message: 'Here are 2 verified doctors for Paediatrics.',
                    source: 'ai_assistant',
                    cards: [doctor(DOCTOR, 'Dr. Meera Iyer', 'active')],
                  },
                  understood: { intent: 'find_doctor', criteria: { specialty: 'Paediatrics' } },
                  degraded: false,
                },
        });
      },
    });
    open('/app/assistant');
    const ue = userEvent.setup();
    await ue.type(await screen.findByLabelText('Your message'), 'my child gets headaches{Enter}');
    expect(await screen.findByText('Question')).toBeInTheDocument();
    const choices = screen.getByRole('group', { name: 'Choose an answer' });
    expect(
      within(choices)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Paediatrics', 'Neurology', 'Any kind of doctor is fine']);
    await ue.click(within(choices).getByRole('button', { name: 'Paediatrics' }));
    expect(
      await screen.findByText('Here are 2 verified doctors for Paediatrics.'),
    ).toBeInTheDocument();
    expect(sent).toEqual(['my child gets headaches', 'Paediatrics']);
    // Suggestions are labelled as such; the answered question can no longer be used.
    expect(screen.getByText('AI suggestion')).toBeInTheDocument();
    expect(within(choices).getByRole('button', { name: 'Neurology' })).toBeDisabled();
  });

  it('falls back to My Doctors when the assistant cannot start', async () => {
    signedIn({
      'POST /api/v1/assistant/sessions': () => problem(503, 'service_unavailable', 'Down'),
    });
    open('/app/assistant');
    expect(await screen.findByText('The assistant isn’t available right now')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Find a doctor in My Doctors' })).toBeInTheDocument();
  });
});

describe('switching between self and a dependent', () => {
  const CHILD = '0192b6f0-0000-7000-8000-0000000000c1';
  const sessionFor = (id, patientId, version = 1) => ({
    ...sessionView(version),
    id,
    patientId,
    actingFor: patientId === PATIENT ? 'self' : 'dependent',
  });

  /**
   * A fake backend that behaves like the real one: each new session starts at version 1,
   * and a message with any other version than the session's current one is refused (409).
   */
  function backend({ hold } = {}) {
    const sessions = new Map();
    let n = 0;
    const calls = signedIn({
      'GET /api/v1/patients/me/dependents': () =>
        json(200, { data: [{ id: CHILD, fullName: 'Kabir Rao' }] }),
      'POST /api/v1/assistant/sessions': (init) => {
        n += 1;
        const patientId = JSON.parse(init.body ?? '{}').patientId ?? PATIENT;
        const id = `0192b6f0-0000-7000-8000-00000000f${String(n).padStart(3, '0')}`;
        sessions.set(id, { patientId, version: 1 });
        return json(201, { data: sessionFor(id, patientId) });
      },
    });
    const fetchMock = globalThis.fetch.getMockImplementation();
    globalThis.fetch.mockImplementation(async (url, init = {}) => {
      const m = /\/assistant\/sessions\/([^/]+)(\/messages)?$/.exec(url);
      if (!m) return fetchMock(url, init);
      calls.push({ key: `${init.method ?? 'GET'} ${url}`, init });
      const s = sessions.get(m[1]);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(init.body);
      if (hold && s.patientId === hold.patientId) await hold.promise;
      if (body.version !== s.version) {
        return problem(409, 'assistant_session_changed', 'This conversation changed.');
      }
      s.version += 1;
      return json(200, {
        data: {
          session: sessionFor(m[1], s.patientId, s.version),
          reply: { kind: 'help', message: `Reply for ${s.patientId} #${s.version}`, cards: [] },
          understood: { intent: null, criteria: {} },
          degraded: false,
        },
      });
    });
    const sent = () =>
      calls
        .filter((c) => c.key.endsWith('/messages'))
        .map((c) => ({ session: c.key.split('/')[5], ...JSON.parse(c.init.body) }));
    return { calls, sent, sessions };
  }

  const say = async (text) => {
    await userEvent.type(await screen.findByLabelText('Your message'), `${text}{Enter}`);
  };
  const choose = async (label) => {
    await userEvent.selectOptions(await screen.findByLabelText(/Showing records of/), label);
  };

  it('self → dependent → self: each patient gets a fresh session and its own version', async () => {
    const api = backend();
    open('/app/assistant');
    await screen.findByRole('option', { name: 'Kabir Rao' });

    // Two turns for self: the self session is now at version 3.
    await say('hello me');
    expect(await screen.findByText(`Reply for ${PATIENT} #2`)).toBeInTheDocument();
    await say('again me');
    expect(await screen.findByText(`Reply for ${PATIENT} #3`)).toBeInTheDocument();

    await choose('Kabir Rao');
    expect(await screen.findByText(/What can I help them with/)).toBeInTheDocument();
    // Nothing of the self conversation is visible for the dependent.
    expect(screen.queryByText('hello me')).not.toBeInTheDocument();
    expect(screen.queryByText(`Reply for ${PATIENT} #3`)).not.toBeInTheDocument();
    await say('hello child');
    expect(await screen.findByText(`Reply for ${CHILD} #2`)).toBeInTheDocument();

    await choose('Me');
    expect(await screen.findByText(/What can I help you with/)).toBeInTheDocument();
    expect(screen.queryByText('hello child')).not.toBeInTheDocument();
    expect(screen.queryByText(`Reply for ${CHILD} #2`)).not.toBeInTheDocument();
    await say('back to me');
    expect(await screen.findByText(`Reply for ${PATIENT} #2`)).toBeInTheDocument();

    // Every first message used the version its own new session was created with; no 409.
    const sent = api.sent();
    expect(sent.map((s) => [s.text, s.version])).toEqual([
      ['hello me', 1],
      ['again me', 2],
      ['hello child', 1],
      ['back to me', 1],
    ]);
    expect(new Set(sent.map((s) => s.session)).size).toBe(3);
    expect(screen.queryByText(/changed in another window|conversation changed/i)).toBeNull();
    // The sessions left behind were ended, not reused.
    const ended = api.calls.filter((c) => c.key.startsWith('DELETE')).map((c) => c.key);
    expect(ended).toEqual([
      `DELETE /api/v1/assistant/sessions/${sent[0].session}`,
      `DELETE /api/v1/assistant/sessions/${sent[2].session}`,
    ]);
    // The dependent's session was created for the dependent.
    const created = api.calls.filter((c) => c.key === 'POST /api/v1/assistant/sessions');
    expect(created.map((c) => JSON.parse(c.init.body ?? '{}').patientId ?? null)).toEqual([
      expect.toBeOneOf([null, PATIENT]),
      CHILD,
      expect.toBeOneOf([null, PATIENT]),
    ]);
  });

  it('a late reply for the previous patient never lands in the new conversation', async () => {
    let release;
    const hold = { patientId: PATIENT, promise: new Promise((r) => (release = r)) };
    const api = backend({ hold });
    open('/app/assistant');
    await screen.findByRole('option', { name: 'Kabir Rao' });

    await say('slow message for me'); // held by the backend
    await choose('Kabir Rao');
    expect(await screen.findByText(/What can I help them with/)).toBeInTheDocument();
    expect(screen.queryByText('slow message for me')).not.toBeInTheDocument();
    expect(screen.queryByText('The assistant is looking this up')).not.toBeInTheDocument();

    // The dependent can send at once (the old request does not block the new session).
    await say('hello child');
    expect(await screen.findByText(`Reply for ${CHILD} #2`)).toBeInTheDocument();

    release();
    await waitFor(() => expect(api.sessions.get(api.sent()[0].session).version).toBe(2));
    // Give React a chance to process the late response, then check it was dropped.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(`Reply for ${PATIENT} #2`)).not.toBeInTheDocument();
    expect(screen.getByText(`Reply for ${CHILD} #2`)).toBeInTheDocument();
    expect(api.sent().map((s) => [s.text, s.version])).toEqual([
      ['slow message for me', 1],
      ['hello child', 1],
    ]);
  });
});
