import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { cn } from "./utils.js";
import type { TableColumn } from "./types.js";

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      className={cn("ui-button", `ui-button-${variant}`, className)}
      {...props}
    />
  );
}

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <section className={cn("ui-card", className)}>{children}</section>;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "danger";
}) {
  return <span className={cn("ui-badge", `ui-badge-${tone}`)}>{children}</span>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("ui-input", props.className)} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("ui-input", props.className)} {...props} />;
}

export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose(): void;
}) {
  return open ? (
    <div className="ui-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="card-heading">
          <h2>{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            ×
          </Button>
        </div>
        {children}
      </div>
    </div>
  ) : null;
}

export function Toast({ children }: { children: ReactNode }) {
  return (
    <div className="ui-toast" role="status">
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="ui-empty">
      <strong>{title}</strong>
      {description && <span>{description}</span>}
    </div>
  );
}

export function Skeleton() {
  return <div className="ui-skeleton" aria-label="Laden" />;
}

export function DataTable<T>({
  rows,
  columns,
  empty = "Keine Einträge",
}: {
  rows: T[];
  columns: TableColumn<T>[];
  empty?: string;
}) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>
                  {column.render
                    ? column.render(row)
                    : String(
                        (row as Record<string, unknown>)[column.key] ?? "—",
                      )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
