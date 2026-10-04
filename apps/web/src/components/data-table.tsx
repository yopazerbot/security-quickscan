import clsx from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SortValue = string | number | Date | null | undefined;

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Value to sort on; columns without it are not sortable. */
  sort?: (row: T) => SortValue;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
}

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

export const PAGE_SIZES = [10, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

function readStored<T>(key: string | undefined, fallback: T): T {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(`qs_table_${key}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string | undefined, value: unknown) {
  if (!key) return;
  try {
    localStorage.setItem(`qs_table_${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const validSize = (n: unknown): PageSize => (PAGE_SIZES.includes(n as PageSize) ? (n as PageSize) : 10);

function compare(a: SortValue, b: SortValue): number {
  // Empty values always sort last, whatever the direction (handled by the caller).
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
}

const isEmpty = (v: SortValue) => v === null || v === undefined || v === '' || (v instanceof Date && Number.isNaN(v.getTime()));

/** Sorts a copy of `rows`; empty values go last in both directions. */
export function sortRows<T>(rows: T[], get: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((a, b) => {
      const ea = isEmpty(a.v);
      const eb = isEmpty(b.v);
      if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
      return (dir === 'asc' ? compare(a.v, b.v) : compare(b.v, a.v)) || a.i - b.i;
    })
    .map((x) => x.row);
}

/** "1 to 10 of 57" (no dashes). */
export const rangeLabel = (start: number, end: number, total: number) => (total === 0 ? '0 of 0' : `${start} to ${end} of ${total}`);

/**
 * Previous/next buttons with a rows-per-page selector. Shared by DataTable, card lists (usePaged) and server-paged
 * tables (Audit), where `total` may be unknown.
 */
export function Pager({
  page,
  pageCount,
  pageSize,
  onPage,
  onPageSize,
  status,
  hasNext,
  hasPrevious,
  label = 'rows',
  className,
}: {
  page: number;
  /** Null when the total is unknown (server cursor paging); then hasNext decides. */
  pageCount: number | null;
  pageSize: number;
  onPage(page: number): void;
  onPageSize(size: PageSize): void;
  status: ReactNode;
  hasNext?: boolean;
  hasPrevious?: boolean;
  label?: string;
  className?: string;
}) {
  const id = useId();
  const canPrev = hasPrevious ?? page > 0;
  const canNext = hasNext ?? (pageCount !== null && page < pageCount - 1);
  return (
    <div className={clsx('no-print flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600', className)}>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-size`} className="text-xs font-medium text-slate-600">
          Rows per page
        </label>
        <select
          id={`${id}-size`}
          value={pageSize}
          onChange={(e) => onPageSize(validSize(Number(e.target.value)))}
          className="rounded-md border-0 bg-white py-1 pl-2 pr-7 text-xs text-slate-800 shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-600" role="status" aria-live="polite" data-testid="pager-status">
          {status}
        </span>
        <button
          type="button"
          aria-label={`Previous page of ${label}`}
          disabled={!canPrev}
          onClick={() => onPage(page - 1)}
          className="rounded-md p-1.5 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Next page of ${label}`}
          disabled={!canNext}
          onClick={() => onPage(page + 1)}
          className="rounded-md p-1.5 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Page size remembered per storage key (10, 50 or 100). */
export function usePageSize(storageKey?: string): [PageSize, (n: PageSize) => void] {
  const [size, setSize] = useState<PageSize>(() => validSize(readStored(storageKey, { size: 10 as number }).size));
  const set = (n: PageSize) => {
    setSize(n);
    writeStored(storageKey, { ...readStored<Record<string, unknown>>(storageKey, {}), size: n });
  };
  return [size, set];
}

/**
 * Client-side paging for card lists: returns the visible slice and the props for <Pager>. Goes back to the first
 * page when the number of items or `resetKey` changes.
 */
export function usePaged<T>(items: T[], storageKey?: string, resetKey?: unknown) {
  const [size, setSize] = usePageSize(storageKey);
  const [page, setPage] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPage(0);
  }, [items.length, resetKey, size]);
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pageCount - 1);
  const start = current * size;
  const visible = items.slice(start, start + size);
  return {
    visible,
    pagerProps: {
      page: current,
      pageCount,
      pageSize: size,
      onPage: setPage,
      onPageSize: setSize,
      status: rangeLabel(items.length ? start + 1 : 0, start + visible.length, items.length),
    },
    /** True when there is more than one page or the size was changed, so a pager is worth showing. */
    showPager: items.length > PAGE_SIZES[0],
  };
}

/**
 * Sortable, paged table. Click a header to sort ascending, then descending, then back to the original order.
 * Page size and sort are remembered per `storageKey`. The table scrolls horizontally inside its container and the
 * header stays visible while scrolling.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  storageKey,
  filterKey,
  empty,
  onRowClick,
  rowLabel,
  rowClassName,
  caption,
  label = 'rows',
  minWidth = '40rem',
  defaultSort,
  className,
  pagerClassName,
  hidePagerWhenSmall = false,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey?: (row: T, index: number) => string;
  /** Remembers page size and sort in this browser. */
  storageKey?: string;
  /** Changing it (e.g. the search text) returns to the first page. */
  filterKey?: unknown;
  empty?: ReactNode;
  /** Makes rows act like buttons (click, Enter or Space). Interactive elements inside a row keep their own behaviour. */
  onRowClick?: (row: T) => void;
  /** Accessible name of a clickable row. */
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  caption?: ReactNode;
  /** What the rows are, for the pager button names ("Next page of users"). */
  label?: string;
  minWidth?: string;
  defaultSort?: SortState | null;
  className?: string;
  pagerClassName?: string;
  /** Hide the pager when everything fits on the smallest page. */
  hidePagerWhenSmall?: boolean;
}) {
  const stored = readStored<{ size?: number; sort?: SortState | null }>(storageKey, {});
  const [size, setSizeState] = useState<PageSize>(validSize(stored.size));
  const [sort, setSortState] = useState<SortState | null>(() => {
    const s = stored.sort === undefined ? (defaultSort ?? null) : stored.sort;
    return s && columns.some((c) => c.key === s.key && c.sort) ? s : null;
  });
  const [page, setPage] = useState(0);
  const persist = (next: { size?: PageSize; sort?: SortState | null }) => writeStored(storageKey, { size, sort, ...next });
  const setSize = (n: PageSize) => {
    setSizeState(n);
    setPage(0);
    persist({ size: n });
  };
  const cycleSort = (key: string) => {
    const next: SortState | null = sort?.key !== key ? { key, dir: 'asc' } : sort.dir === 'asc' ? { key, dir: 'desc' } : null;
    setSortState(next);
    setPage(0);
    persist({ sort: next });
  };

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPage(0);
  }, [rows.length, filterKey]);

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    return col?.sort ? sortRows(rows, col.sort, sort.dir) : rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort?.key, sort?.dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pageCount - 1);
  const start = current * size;
  const visible = sorted.slice(start, start + size);
  const alignCls = (a?: Column<T>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  return (
    <div className={className}>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-left text-sm" style={{ minWidth }}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10 border-b border-slate-100 bg-white text-xs uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgb(241_245_249)]">
            <tr>
              {columns.map((c, i) => {
                const active = sort?.key === c.key;
                const ariaSort = c.sort ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined;
                const pad = i === 0 ? 'pl-6 pr-3' : i === columns.length - 1 ? 'pl-3 pr-6' : 'px-3';
                return (
                  <th key={c.key} scope="col" aria-sort={ariaSort} className={clsx('py-3 font-medium', pad, alignCls(c.align), c.headerClassName)}>
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() => cycleSort(c.key)}
                        className={clsx(
                          'group inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                          active && 'text-slate-800',
                          c.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {c.header}
                        {active ? (
                          sort!.dir === 'asc' ? (
                            <ArrowUp className="size-3.5" aria-hidden />
                          ) : (
                            <ArrowDown className="size-3.5" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="size-3.5 text-slate-400 group-hover:text-slate-600" aria-hidden />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((row, ri) => (
              <tr
                key={rowKey ? rowKey(row, start + ri) : start + ri}
                className={clsx('align-top', onRowClick && 'cursor-pointer transition hover:bg-slate-50 focus:outline-none focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500', rowClassName?.(row))}
                {...(onRowClick
                  ? {
                      tabIndex: 0,
                      'aria-label': rowLabel?.(row),
                      onClick: (e) => {
                        // Links, buttons and form controls inside the row keep their own behaviour.
                        if ((e.target as HTMLElement).closest('a,button,input,select,textarea,summary,label')) return;
                        onRowClick(row);
                      },
                      onKeyDown: (e) => onRowKey(e, row),
                    }
                  : {})}
              >
                {columns.map((c, i) => (
                  <td key={c.key} className={clsx('py-3', i === 0 ? 'pl-6 pr-3' : i === columns.length - 1 ? 'pl-3 pr-6' : 'px-3', alignCls(c.align), c.className)}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {empty ?? <p className="px-6 py-8 text-center text-sm text-slate-500">Nothing to show.</p>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!(hidePagerWhenSmall && sorted.length <= PAGE_SIZES[0]) && sorted.length > 0 && (
        <Pager
          className={clsx('border-t border-slate-100 px-6 py-3', pagerClassName)}
          page={current}
          pageCount={pageCount}
          pageSize={size}
          onPage={setPage}
          onPageSize={setSize}
          label={label}
          status={rangeLabel(start + 1, start + visible.length, sorted.length)}
        />
      )}
    </div>
  );
}
