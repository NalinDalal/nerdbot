import { useState } from "react";

export function EntityPicker<T extends { id: string; name: string }>({ items, value, onChange, placeholder }: {
  items: T[]; value: string; onChange: (id: string) => void; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const filtered = items.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder ?? "Search"} />
      <select value={value} onChange={e => onChange(e.target.value)}>
        {filtered.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </div>
  );
}
