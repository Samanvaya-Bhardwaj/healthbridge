import { Pill } from 'lucide-react';
import { careImages } from '../../assets/care/index.js';
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
        image={careImages.medicines}
        eyebrow="My health"
        title="Prescriptions"
        description="Medicines your doctors have prescribed for you."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      <PatientPrescriptions patientId={patientId} audience="patient" />
    </div>
  );
}
