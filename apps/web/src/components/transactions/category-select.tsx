"use client";

export interface CategoryOption {
  id: string;
  name: string;
  emoji: string | null;
  group_name: string;
  group_sort: number;
  sort_order: number;
}

export function CategorySelect({
  categories,
  value,
  onChange,
  className,
  placeholder = "Category…",
}: {
  categories: CategoryOption[];
  value: string | null;
  onChange: (id: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const groups = new Map<string, CategoryOption[]>();
  for (const c of [...categories].sort(
    (a, b) => a.group_sort - b.group_sort || a.sort_order - b.sort_order
  )) {
    if (!groups.has(c.group_name)) groups.set(c.group_name, []);
    groups.get(c.group_name)!.push(c);
  }

  return (
    <select
      value={value ?? ""}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className={
        className ??
        "h-7 max-w-44 rounded border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      }
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {[...groups.entries()].map(([group, cats]) => (
        <optgroup key={group} label={group}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.emoji ? `${c.emoji} ` : ""}
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
