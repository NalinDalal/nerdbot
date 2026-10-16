import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
      const message = err instanceof Error ? err.message : String(err);
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
              {...register(field.name, { required: field.required ? `${field.label} is required` : false })}
            />
          ) : field.type === "select" ? (
            <select {...register(field.name, { required: field.required ? `${field.label} is required` : false })}>
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
              {...register(field.name, { required: field.required ? `${field.label} is required` : false })}
            />
          )}
          {field.hint ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{field.hint}</div> : null}
        </Field>
      ))}
      <button className="primary" type="submit" disabled={isSubmitting}>
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
