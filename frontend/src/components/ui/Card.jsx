/** Bordered surface for grouping related content. */
export function Card({ as: Component = 'section', className = '', children, ...props }) {
  return (
    <Component
      className={`rounded-2xl border border-border bg-surface-raised p-6 ${className}`}
      {...props}
    >
      {children}
    </Component>
  );
}
