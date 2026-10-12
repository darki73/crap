import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Pagination bounds rendering only; totals and persistence still use the full data. */
export function Paginated<T>({
  items,
  label,
  children,
  pageSize = 10,
  snapshot = false,
  loadedOnly = false,
}: {
  items: readonly T[];
  label: string;
  children: (rows: readonly T[], offset: number) => ReactNode;
  pageSize?: number;
  snapshot?: boolean;
  loadedOnly?: boolean;
}) {
  const [requestedPage, setPage] = useState(0);
  const [frozen, setFrozen] = useState<readonly T[] | null>(null);
  const rows = frozen ?? items;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  // Keep the next refresh from reviving a page that disappeared after deletion.
  if (requestedPage !== page) setPage(page);
  const offset = page * pageSize;
  function go(next: number) {
    if (snapshot && !frozen) setFrozen([...items]);
    setPage(next);
  }
  return (
    <>
      {children(rows.slice(offset, offset + pageSize), offset)}
      {rows.length > 0 && (
        <nav
          aria-label={`${label} pagination`}
          className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs"
        >
          <span className="text-muted-foreground" aria-live="polite">
            {offset + 1}–{Math.min(offset + pageSize, rows.length)} of{" "}
            {rows.length}
            {loadedOnly ? " loaded" : ""}
          </span>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Previous ${label} page`}
                disabled={page === 0}
                onClick={() => go(page - 1)}
              >
                <ChevronLeft />
              </Button>
              <span className="whitespace-nowrap text-muted-foreground">
                Page {page + 1} of {pages}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Next ${label} page`}
                disabled={page + 1 >= pages}
                onClick={() => go(page + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          )}
          {frozen && (
            <div className="flex w-full flex-wrap items-center justify-between gap-2 text-muted-foreground">
              <span>History paused while you browse.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setFrozen(null);
                  setPage(0);
                }}
              >
                Show latest {label}
              </Button>
            </div>
          )}
        </nav>
      )}
    </>
  );
}
