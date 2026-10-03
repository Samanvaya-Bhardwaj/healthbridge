import { useCallback, useState } from 'react';
import { Button } from './Button.jsx';
import { Dialog } from './Dialog.jsx';

/**
 * Promise-based confirmation, replacing window.confirm:
 *   const { confirm, dialog } = useConfirm();
 *   if (await confirm({ title, description, confirmLabel })) …
 *   return <>…{dialog}</>;
 */
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback(
    (options) =>
      new Promise((resolve) => {
        setState({ ...options, resolve });
      }),
    [],
  );
  const close = (result) => {
    state?.resolve(result);
    setState(null);
  };
  const dialog = (
    <Dialog
      open={Boolean(state)}
      title={state?.title}
      description={state?.description}
      tone={state?.tone}
      onClose={() => close(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {state?.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            data-autofocus
            variant={state?.destructive ? 'destructive' : 'primary'}
            onClick={() => close(true)}
          >
            {state?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    />
  );
  return { confirm, dialog };
}
