import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { usePatientChoice } from './usePatientChoice.js';
import { PatientSelect } from './PatientSelect.jsx';
import { Timeline } from './Timeline.jsx';
import { History } from 'lucide-react';
import { PageHeader } from '../../components/ui/Typography.jsx';
import { MissingProfileNotice } from '../patients/MissingProfileNotice.jsx';

/** Patient (and managing guardian) health timeline. */
export function TimelinePage() {
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (missingProfile) return <MissingProfileNotice />;
  return (
    <div className="space-y-6">
      <PageHeader
        icon={History}
        eyebrow="My health"
        title="Timeline"
        description="Your visits, documents, verified lab values, prescriptions and follow-ups in one history. Each entry says where it came from: reported by you, by your doctor, or verified."
        actions={<PatientSelect choices={choices} value={patientId} onChange={setPatientId} />}
      />
      <Card>
        <Timeline patientId={patientId} allowExport />
      </Card>
    </div>
  );
}
