import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PATIENT_SEX, patientProfileSchema } from '@healthbridge/shared';
import { TextField } from '../../components/ui/TextField.jsx';
import { SelectField } from '../../components/ui/SelectField.jsx';
import { Button } from '../../components/ui/Button.jsx';

const SEX_OPTIONS = PATIENT_SEX.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
const EMPTY = {
  fullName: '',
  preferredName: '',
  dateOfBirth: '',
  sex: '',
  phone: '',
  city: '',
  state: '',
  postalCode: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  emergencyContactRelationship: '',
};

/** Basic patient profile: identity and contact details only — no medical information. */
export function PatientProfileForm({
  initial,
  onSubmit,
  submitLabel,
  extraFields,
  schema = patientProfileSchema,
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    // Only editable fields: read-only attributes (id, status, …) must not be submitted.
    defaultValues: Object.fromEntries(Object.keys(EMPTY).map((k) => [k, initial?.[k] ?? ''])),
  });
  const field = (name, label, props = {}) => (
    <TextField label={label} error={errors[name]?.message} {...register(name)} {...props} />
  );

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => onSubmit(values, setError))}
      className="space-y-6"
    >
      <fieldset className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-text">Personal details</legend>
        {field('fullName', 'Full name', { autoComplete: 'name' })}
        {field('preferredName', 'Preferred name (optional)')}
        {field('dateOfBirth', 'Date of birth', { type: 'date' })}
        <SelectField
          label="Sex (optional)"
          placeholder="Prefer not to say"
          options={SEX_OPTIONS}
          error={errors.sex?.message}
          {...register('sex', { setValueAs: (v) => v || null })}
        />
        {extraFields?.(register, errors)}
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-text">Contact</legend>
        {field('phone', 'Mobile number (optional)', { type: 'tel', placeholder: '+919812345678' })}
        {field('city', 'City (optional)')}
        {field('state', 'State (optional)')}
        {field('postalCode', 'PIN code (optional)')}
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold text-text">
          Emergency contact (optional)
        </legend>
        {field('emergencyContactName', 'Name')}
        {field('emergencyContactPhone', 'Phone', { type: 'tel' })}
        {field('emergencyContactRelationship', 'Relationship')}
      </fieldset>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}
