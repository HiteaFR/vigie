export default function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line px-6 py-10 text-center">
      {Icon && <Icon size={22} className="mx-auto mb-2 text-subtle" aria-hidden />}
      <div className="text-sm font-medium text-fg">{title}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  )
}
