import { Pill } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { LoadingState } from '../../components/ui/EmptyState.jsx';
import { usePatientChoice } from '../records/usePatientChoice.js';
import { PatientSelect } from '../records/PatientSelect.jsx';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';
import { PatientPrescriptions } from './Prescriptions.jsx';

/** Patient side: every signed prescription for me or a family member I manage. */
export function PrescriptionsPage() {
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  if (isPending) return <LoadingState label="Loading" />;
  if (missingProfile) return <MissingProfileNotice />;
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Pill}
        eyebrow="My health"
        title="Prescriptions"
        description="Prescriptions your doctors sign during consultations. Corrections appear as new versions; earlier versions stay visible."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      <PatientPrescriptions patientId={patientId} audience="patient" />
    </div>
  );
}
