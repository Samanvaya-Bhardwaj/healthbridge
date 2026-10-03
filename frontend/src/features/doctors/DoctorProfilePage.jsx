import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  DOCTOR_REGISTRATION_FIELDS,
  doctorProfileSchema,
  doctorProfileUpdateSchema,
} from '@healthbridge/shared';
import { doctorsApi, clinicsApi } from '../../lib/domainApi.js';
import { ApiError } from '../../lib/apiClient.js';
import { applyFieldErrors, authErrorMessage } from '../auth/errorMessages.js';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { TextField } from '../../components/ui/TextField.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { ClipboardList } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { controlClass } from '../../components/ui/fieldStyles.js';

const LOCKED = new Set(['pending', 'under_review', 'verified']);
const VERIFICATION_HELP = {
  unverified: 'Submit your registration details so our team can verify them.',
  pending: 'Submitted. Our team will review your registration.',
  under_review: 'Your registration is being reviewed.',
  verified: 'Verified. Patients can find you and add you to their care team.',
  rejected: 'Verification was not approved. Correct your details and resubmit.',
  suspended: 'Your profile is suspended. Contact HealthBridge support.',
};

const toForm = (p) => ({
  professionalName: p?.professionalName ?? '',
  registrationNumber: p?.registrationNumber ?? '',
  registrationCouncil: p?.registrationCouncil ?? '',
  registrationYear: p?.registrationYear ?? '',
  primarySpecialization: p?.primarySpecialization ?? '',
  yearsOfExperience: p?.yearsOfExperience ?? 0,
  degree: p?.qualifications?.[0]?.degree ?? '',
  institution: p?.qualifications?.[0]?.institution ?? '',
  qualificationYear: p?.qualifications?.[0]?.year ?? '',
  languages: p?.languages?.join(', ') ?? '',
  bio: p?.bio ?? '',
});

/** Flat form fields → API shape (validated by the shared schema). */
const fromForm = (v) => ({
  professionalName: v.professionalName,
  registrationNumber: v.registrationNumber,
  registrationCouncil: v.registrationCouncil,
  registrationYear: Number(v.registrationYear),
  primarySpecialization: v.primarySpecialization,
  yearsOfExperience: Number(v.yearsOfExperience),
  qualifications: [
    { degree: v.degree, institution: v.institution, year: Number(v.qualificationYear) },
  ],
  languages: v.languages
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  bio: v.bio,
});

function DoctorForm({ profile, onSaved }) {
  const [message, setMessage] = useState(null);
  const locked = profile && LOCKED.has(profile.verificationStatus);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: toForm(profile),
    resolver: async (values, ctx, options) => {
      const mapped = fromForm(values);
      // Locked registration fields are disabled (not submitted) and validated as a partial update.
      if (locked) for (const key of DOCTOR_REGISTRATION_FIELDS) delete mapped[key];
      const schema = profile ? doctorProfileUpdateSchema : doctorProfileSchema;
      const result = await zodResolver(schema)(mapped, ctx, options);
      if (Object.keys(result.errors).length) {
        const flat = {};
        for (const [key, err] of Object.entries(result.errors)) {
          if (key === 'qualifications')
            flat.degree = {
              message: 'Add your primary qualification (degree, institution, year).',
            };
          else flat[key] = err;
        }
        return { values: {}, errors: flat };
      }
      return { values: mapped, errors: {} };
    },
  });

  const onSubmit = async (values) => {
    setMessage(null);
    try {
      if (profile) await doctorsApi.updateMe(values);
      else await doctorsApi.createMe(values);
      setMessage({ tone: 'success', text: 'Saved.' });
      onSaved();
    } catch (error) {
      if (!applyFieldErrors(error, setError))
        setMessage({ tone: 'error', text: authErrorMessage(error) });
    }
  };
  const f = (name, label, props = {}) => (
    <TextField label={label} error={errors[name]?.message} {...register(name)} {...props} />
  );

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-text">Professional details</legend>
        {f('professionalName', 'Name as shown to patients', { placeholder: 'Dr. …' })}
        {f('primarySpecialization', 'Specialization')}
        {f('yearsOfExperience', 'Years of experience', { type: 'number', min: 0 })}
        {f('languages', 'Languages (comma-separated)')}
      </fieldset>
      <fieldset className="grid gap-5 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold text-text">
          Medical registration{' '}
          {locked && (
            <span className="font-normal text-text-subtle">
              (locked during review / after verification)
            </span>
          )}
        </legend>
        {f('registrationNumber', 'Registration number', { disabled: locked })}
        {f('registrationCouncil', 'Medical council', { disabled: locked })}
        {f('registrationYear', 'Year of registration', { type: 'number', disabled: locked })}
      </fieldset>
      <fieldset className="grid gap-5 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold text-text">Primary qualification</legend>
        {f('degree', 'Degree')}
        {f('institution', 'Institution')}
        {f('qualificationYear', 'Year', { type: 'number' })}
      </fieldset>
      <div>
        <label htmlFor="doctor-bio" className="block text-sm font-medium text-text">
          About (optional)
        </label>
        <textarea id="doctor-bio" rows={3} className={controlClass()} {...register('bio')} />
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : profile ? 'Save changes' : 'Create doctor profile'}
      </Button>
    </form>
  );
}

function Verification({ profile, onChange }) {
  const history = useQuery({
    queryKey: ['doctors', 'verification'],
    queryFn: doctorsApi.verificationHistory,
  });
  const submit = useMutation({ mutationFn: doctorsApi.submitVerification, onSuccess: onChange });
  const canSubmit = ['unverified', 'rejected', 'suspended'].includes(profile.verificationStatus);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-text">
            Verification <StatusBadge status={profile.verificationStatus} />
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {VERIFICATION_HELP[profile.verificationStatus]}
          </p>
        </div>
        {canSubmit && (
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            Submit for verification
          </Button>
        )}
      </div>
      {submit.isError && (
        <Alert tone="error" className="mt-4">
          {authErrorMessage(submit.error)}
        </Alert>
      )}
      {history.data?.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-text-subtle">
          {history.data.map((h) => (
            <li key={h.id}>
              {new Date(h.submittedAt).toLocaleDateString('en-IN')}: {h.status.replace('_', ' ')}
              {h.decisionReasonCode && ` (${h.decisionReasonCode.replace(/_/g, ' ')})`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Clinics() {
  const queryClient = useQueryClient();
  const clinics = useQuery({ queryKey: ['doctors', 'clinics'], queryFn: doctorsApi.myClinics });
  const respond = useMutation({
    mutationFn: ({ id, action }) => clinicsApi.respond(id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doctors', 'clinics'] }),
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-text">Clinics</h2>
      {clinics.data?.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">You are not a member of any clinic yet.</p>
      )}
      <ul className="mt-4 divide-y divide-border">
        {clinics.data?.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <p className="flex items-center gap-2 text-sm font-medium text-text">
              {m.clinic.name} <StatusBadge status={m.status} />
            </p>
            {m.status === 'invited' && (
              <div className="flex gap-2">
                <Button onClick={() => respond.mutate({ id: m.id, action: 'accept' })}>
                  Accept
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => respond.mutate({ id: m.id, action: 'decline' })}
                >
                  Decline
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DoctorProfilePage() {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ['doctors', 'me'], queryFn: doctorsApi.me, retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['doctors'] });
  const missing = profile.error instanceof ApiError && profile.error.status === 404;
  return (
    <div className="space-y-6">
      <PageHeader
        icon={ClipboardList}
        eyebrow="Practice"
        title="Professional profile"
        description="Your professional details, verification status and clinics. Only verified doctors appear to patients."
      />
      {profile.isPending && <Skeleton className="h-40 w-full" />}
      {profile.data && <Verification profile={profile.data} onChange={refresh} />}
      <Card>
        {(profile.data || missing) && (
          <DoctorForm
            key={profile.data?.updatedAt ?? 'new'}
            profile={profile.data}
            onSaved={refresh}
          />
        )}
      </Card>
      {profile.data?.verificationStatus === 'verified' && <Clinics />}
    </div>
  );
}
