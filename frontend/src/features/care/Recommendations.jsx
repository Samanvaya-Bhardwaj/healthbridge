import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { ASSISTANT_SPECIALTIES } from '@healthbridge/shared';
import { patientsApi } from '../../lib/domainApi.js';
import { authErrorMessage } from '../auth/errorMessages.js';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button, ButtonLink } from '../../components/ui/Button.jsx';
import { SelectField, TextField } from '../../components/ui/Fields.jsx';
import { PersonIdentity } from '../../components/ui/Identity.jsx';
import { EmptyState, LoadingState } from '../../components/ui/EmptyState.jsx';
import { SectionHeader } from '../../components/ui/Typography.jsx';
import { whySuggested } from './recommendationText.js';

const MODES = [
  { value: 'online', label: 'Online' },
  { value: 'in_clinic', label: 'In clinic' },
];
const EMPTY = { specialty: '', city: '', language: '', mode: '' };

/**
 * M13.3: doctors recommended for this patient, by the criteria they choose (speciality,
 * city, language, consultation type) and what HealthBridge already knows on the patient
 * side (care team, past visits, profile city and language, soonest free time). Each one
 * says why, and what to do next. Suggestions, never bookings.
 */
export function Recommendations({ patientId, onRequest, requesting }) {
  const [draft, setDraft] = useState(EMPTY);
  const [criteria, setCriteria] = useState(EMPTY);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const list = useQuery({
    queryKey: ['recommendations', patientId, criteria],
    queryFn: () => patientsApi.recommendations(patientId, { ...criteria, timeZone, limit: 5 }),
    enabled: Boolean(patientId),
  });
  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const filtered = Object.values(criteria).some(Boolean);

  return (
    <section aria-labelledby="recommended-heading" className="mt-6">
      <SectionHeader
        as="h3"
        id="recommended-heading"
        icon={Sparkles}
        title="Recommended for you"
        description="Choose what matters to you. We suggest verified doctors who match, with the reasons, and doctors you already know first."
      />
      <form
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          setCriteria({
            specialty: draft.specialty,
            city: draft.city.trim(),
            language: draft.language.trim(),
            mode: draft.mode,
          });
        }}
      >
        <SelectField
          label="Speciality"
          value={draft.specialty}
          onChange={set('specialty')}
          placeholder="Any speciality"
          options={ASSISTANT_SPECIALTIES.map((s) => ({ value: s, label: s }))}
        />
        <TextField label="City" value={draft.city} onChange={set('city')} placeholder="Any city" />
        <TextField
          label="Language"
          value={draft.language}
          onChange={set('language')}
          placeholder="Any language"
        />
        <SelectField
          label="Consultation"
          value={draft.mode}
          onChange={set('mode')}
          placeholder="Online or in clinic"
          options={MODES}
        />
        <div className="sm:col-span-4">
          <Button type="submit" variant="secondary">
            Show recommendations
          </Button>
        </div>
      </form>

      {list.isPending && <LoadingState label="Finding doctors for you" rows={2} className="mt-4" />}
      {list.isError && (
        <Alert tone="error" className="mt-4">
          {list.error?.status === 400
            ? 'Check the city and language: use letters only.'
            : authErrorMessage(list.error)}
        </Alert>
      )}
      {list.data?.length === 0 && (
        <div className="mt-4">
          <EmptyState compact title="No verified doctors match all of these" icon={Sparkles}>
            {filtered
              ? 'Try fewer choices, for example any city or both consultation types.'
              : 'No recommendations yet.'}
          </EmptyState>
        </div>
      )}
      <ul className="mt-2 divide-y divide-border">
        {list.data?.map((r) => (
          <li key={r.doctor.id} className="py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <PersonIdentity
                name={r.doctor.professionalName}
                verified
                detail={[
                  r.doctor.primarySpecialization,
                  r.doctor.yearsOfExperience
                    ? `${r.doctor.yearsOfExperience} yrs experience`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
              {r.nextStep.type === 'book' ? (
                <ButtonLink
                  as={Link}
                  size="sm"
                  variant="secondary"
                  to={`/app/appointments/book?doctorId=${r.doctor.id}&patientId=${patientId}${
                    r.nextStep.mode ? `&mode=${r.nextStep.mode}` : ''
                  }${r.nextStep.startsAt ? `&startsAt=${encodeURIComponent(r.nextStep.startsAt)}` : ''}`}
                >
                  Book with {r.doctor.professionalName}
                </ButtonLink>
              ) : r.nextStep.type === 'await_acceptance' ? (
                <Badge tone="warning">Request sent</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={requesting}
                  onClick={() => onRequest(r.doctor)}
                >
                  Request care
                </Button>
              )}
            </div>
            {whySuggested(r) && (
              <p className="mt-1 text-sm text-text-muted sm:pl-12">
                Why suggested: {whySuggested(r)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
