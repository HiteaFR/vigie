// Titled section of the drawers
export default function Section({ icon: Icon, title, children, extra }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
        <Icon size={13} aria-hidden /> {title}
        {extra && <span className="ml-auto text-2xs font-normal normal-case tracking-normal text-subtle">{extra}</span>}
      </h3>
      {children}
    </section>
  )
}
