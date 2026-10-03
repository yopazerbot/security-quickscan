/**
 * Where a scan row links to. Drafts open the wizard; finished scans with results open the report;
 * failed scans and scans still in flight open the progress page, which explains what happened and offers a rescan.
 */
export function scanLink(scan: { id: string; status: string }): string {
  switch (scan.status) {
    case 'draft':
      return `/scans/${scan.id}/wizard`;
    case 'completed':
    case 'cancelled':
      return `/scans/${scan.id}/report`;
    default:
      return `/scans/${scan.id}/progress`;
  }
}
