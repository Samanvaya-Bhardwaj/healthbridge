import { Link } from 'react-router';
import { UserRound } from 'lucide-react';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { ButtonLink } from '../../components/ui/Button.jsx';

/** First-use state for patient pages that need a health profile. */
export function MissingProfileNotice() {
  return (
    <EmptyState
      icon={UserRound}
      title="Create your health profile first"
      action={
        <ButtonLink as={Link} to="/app/profile" icon={UserRound}>
          Create profile
        </ButtonLink>
      }
    >
      Your health profile holds your basic details (name, date of birth, contact). Your records,
      appointments and prescriptions are linked to it.
    </EmptyState>
  );
}
