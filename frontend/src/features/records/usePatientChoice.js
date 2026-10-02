import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { patientsApi } from '../../lib/domainApi.js';

/** The signed-in patient and the dependents they manage, with a selection. */
export function usePatientChoice() {
  const me = useQuery({ queryKey: ['patients', 'me'], queryFn: patientsApi.me, retry: false });
  const dependents = useQuery({
    queryKey: ['patients', 'dependents'],
    queryFn: patientsApi.dependents,
  });
  const choices = [
    ...(me.data ? [{ id: me.data.id, label: 'Me' }] : []),
    ...(dependents.data ?? []).map((d) => ({ id: d.id, label: d.fullName })),
  ];
  const [selected, setSelected] = useState(null);
  return {
    choices,
    patientId: selected ?? choices[0]?.id ?? null,
    setPatientId: setSelected,
    isPending: me.isPending,
    missingProfile: me.isError,
  };
}
