import { useState } from "react";
import { FORM_INPUT } from "./components";

/**
 * A searchable picker over one entity kind (teammates, issues, ...).
 *
 * A select the owner can narrow by typing — raw id inputs sent people
 * hunting through another tab for a `tm_...` string before every submit.
 * Passing an empty option lets the owner leave the choice unmade: owner
 * and issue are optional facts about a task.
 */
export function EntityPicker<T extends { id: string; name: string }>({
  items,
  value,
  onChange,
  placeholder,
}: {
  items: T[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const filtered = items.filter((item) => item.name.toLowerCase().includes(query));
  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:flex-row">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder ?? "Search"}
        aria-label={placeholder ?? "Search"}
        className={`${FORM_INPUT} sm:max-w-[12rem]`}
      />
      <select value={value} onChange={(e) => onChange(e.target.value)} className={FORM_INPUT} aria-label="Selected entity">
        <option value="">—</option>
        {filtered.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </div>
  );
}
