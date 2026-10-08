// A table above 768px, stacked rows below. Column headers are Latin mono
// eyebrows; cell content carries its own lang. Always inside a horizontal
// scroll container so a wide table never scrolls the page.
export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
  /** Hide on the stacked (phone) layout. */
  phoneHidden?: boolean;
  /** The primary cell on the phone layout (rendered first, bold). */
  primary?: boolean;
  className?: string;
}

export default function DataList<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty: React.ReactNode;
  rowClassName?: (row: T) => string;
}) {
  if (rows.length === 0) return <div className="px-5 py-10 text-center text-small text-muted">{empty}</div>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const onKey = (r: T) => (e: React.KeyboardEvent) => {
    if (onRowClick && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onRowClick(r);
    }
  };
  return (
    <>
      {/* ≥ md: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-hairline bg-surface-raise/60">
              {columns.map((c) => (
                <th key={c.key} className={`mono-label px-4 py-2.5 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? onKey(r) : undefined}
                className={`border-b border-hairline/70 last:border-0 ${onRowClick ? "cursor-pointer hover:bg-surface-raise/50 focus-visible:bg-surface-raise/50" : ""} ${rowClassName?.(r) ?? ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 align-top ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* < md: stacked rows */}
      <ul className="divide-y divide-hairline md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className={rowClassName?.(r) ?? ""}>
            <div
              role={onRowClick ? "button" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? onKey(r) : undefined}
              className={`px-4 py-3 ${onRowClick ? "cursor-pointer active:bg-surface-raise/60" : ""}`}
            >
              <div className="text-body font-medium text-ink">{primary.cell(r)}</div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted">
                {columns
                  .filter((c) => c !== primary && !c.phoneHidden)
                  .map((c) => (
                    <div key={c.key} className="min-w-0">
                      {c.cell(r)}
                    </div>
                  ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
