import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { usePatientChoice } from './usePatientChoice.js';
import { PatientSelect } from './PatientSelect.jsx';
import { Timeline } from './Timeline.jsx';

/** Patient (and managing guardian) health timeline. */
export function TimelinePage() {
  const { choices, patientId, setPatientId, isPending, missingProfile } = usePatientChoice();
  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (missingProfile) return <Alert tone="info">Create your patient profile first.</Alert>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Health timeline</h1>
          <p className="mt-2 text-text-muted">
            Appointments, documents and lab values verified by your doctors. Each entry shows where
            it came from.
          </p>
        </div>
        <PatientSelect choices={choices} value={patientId} onChange={setPatientId} />
      </div>
      <Card>
        <Timeline patientId={patientId} allowExport />
      </Card>
    </div>
  );
}
