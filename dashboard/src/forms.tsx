import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "./api";
import { notifyError } from "./app";
import { Button, ERROR_BOX, Field } from "./components";

export interface FormField {
  name: string;
  label: string;
  type?: "text" | "password" | "textarea" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

const CONTROL_CLASS =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]";

type ControlEvent = React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

/** Small controlled form over a flat string map. One required rule per
 *  field, inline errors, and an honest inline failure box — deliberately
 *  plain React instead of a form library, which cost more bundle than it
 *  bought for a form this simple. */
export function EntityForm({
  fields,
  submitLabel,
  onSubmit,
}: {
  fields: FormField[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, ""])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (name: string) => (event: ControlEvent) =>
    setValues((prev) => ({ ...prev, [name]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && !(values[field.name] ?? "").trim()) {
        next[field.name] = `${field.label} is required`;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFailed(null);
    setSubmitting(true);
    try {
      await onSubmit(values);
      toast.success("Saved");
    } catch (err) {
      const message = describeError(err);
      setFailed(message);
      notifyError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {failed ? (
        <div className={ERROR_BOX} role="alert">
          {failed}
        </div>
      ) : null}
      {fields.map((field) => (
        <Field key={field.name} label={field.label} error={errors[field.name]}>
          {field.type === "textarea" ? (
            <textarea
              rows={3}
              placeholder={field.placeholder}
              className={`${CONTROL_CLASS} resize-y`}
              value={values[field.name] ?? ""}
              onChange={set(field.name)}
            />
          ) : field.type === "select" ? (
            <select
              className={CONTROL_CLASS}
              value={values[field.name] ?? ""}
              onChange={set(field.name)}
            >
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === "password" ? "password" : "text"}
              placeholder={field.placeholder}
              autoComplete="off"
              className={CONTROL_CLASS}
              value={values[field.name] ?? ""}
              onChange={set(field.name)}
            />
          )}
          {field.hint ? (
            <div className="text-[var(--step-minus-1)] text-[var(--faint)]">{field.hint}</div>
          ) : null}
        </Field>
      ))}
      <Button variant="primary" type="submit" disabled={submitting} className="mt-2">
        {submitting ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
