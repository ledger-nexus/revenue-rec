import { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function EmptyState({
  title,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { title: string; children?: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-200 bg-ink-50/50 px-6 py-10 text-center",
        className
      )}
      {...props}
    >
      <div className="text-sm font-medium text-ink-700">{title}</div>
      {children ? <div className="text-xs text-ink-500">{children}</div> : null}
    </div>
  );
}
