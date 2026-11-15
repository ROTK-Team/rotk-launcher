import { useEffect, useId, useRef, type ReactNode } from "react";

/** A titled block of rows. */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

/** One setting: what it is on the left, its control on the right. */
export function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <strong>{title}</strong>
        {hint && <div className="settings-row__hint">{hint}</div>}
      </div>
      {children && <div className="settings-row__control">{children}</div>}
    </div>
  );
}

export function Switch({ label, checked, disabled, describedBy, onChange }: {
  label: string; checked: boolean; disabled?: boolean; describedBy?: string; onChange(checked: boolean): void;
}) {
  return (
    <label className="settings-switch">
      <input type="checkbox" role="switch" aria-label={label} aria-describedby={describedBy} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

/** A choice among a few values, all in sight. */
export function Segments<T extends string | number>({ label, value, options, disabled, onChange }: {
  label: string; value: T; options: ReadonlyArray<readonly [T, string]>; disabled?: boolean; onChange(value: T): void;
}) {
  return (
    <div className="settings-segments" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={String(option)} type="button" role="radio" aria-checked={option === value} disabled={disabled} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * Asks before an action that cannot be undone. A native modal dialog: the
 * focus stays inside it and Escape cancels, without any code here.
 */
export function ConfirmDialog({ title, message, detail, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string; message: string; detail?: string; confirmLabel: string; cancelLabel: string; onConfirm(): void; onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} className="launcher-dialog" aria-labelledby={titleId} onCancel={onCancel} onClose={onCancel}>
      <h2 id={titleId}>{title}</h2>
      {detail && <code title={detail}>{detail}</code>}
      <p>{message}</p>
      <div className="launcher-dialog__actions">
        <button type="button" className="launcher-button launcher-button--ghost" autoFocus onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className="launcher-button launcher-button--danger-solid" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
