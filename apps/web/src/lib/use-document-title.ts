import { PRODUCT_NAME } from '@qs/shared';
import { useEffect } from 'react';

/** Sets the browser tab title to "<title> | Security QuickScan" while the calling page is mounted. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [title]);
}
