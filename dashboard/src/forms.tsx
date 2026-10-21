import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describeError } from "./api";
import { notifyError } from "./app";
import { Field, Modal } from "./components";

export interface FormField {
  name: string;
  label: string;
  type?: "text" | "password" | "textarea" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export function EntityForm({
  fields,
  submitLabel,
  onSubmit,
}: {
  fields: FormField[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Record<string, string>>();
  const [failed, setFailed] = useState<string | null>(null);

  const submit = handleSubmit(async (values) => {
    setFailed(null);
    try {
      await onSubmit(values);
      toast.success("Saved");
    } catch (err) {
      const message = describeError(err);
      setFailed(message);
      notifyError(err);
    }
  });

  return (
    <form onSubmit={submit}>
      {failed ? (
        <div className="error-box" role="alert">
          {failed}
        </div>
      ) : null}
      {fields.map((field) => (
        <Field key={field.name} label={field.label} error={errors[field.name]?.message as string | undefined}>
          {field.type === "textarea" ? (
            <textarea
              rows={3}
              placeholder={field.placeholder}
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              {...register(field.name, { required: field.required ? `${field.label} is required` : false })}
            />
          ) : field.type === "select" ? (
            <select
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              {...register(field.name, { required: field.required ? `${field.label} is required` : false })}
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
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--step-0)] outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
              {...register(field.name, { required: field.required ? `${field.label} is required` : false })}
            />
          )}
          {field.hint ? (
            <div className="text-[var(--step-minus-1)] text-[var(--faint)]">{field.hint}</div>
          ) : null}
        </Field>
      ))}
      <button className="button primary mt-2" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function FormModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      {children}
    </Modal>
  );
}
