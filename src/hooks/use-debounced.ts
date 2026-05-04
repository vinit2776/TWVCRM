/**
 * useDebounced — return a value that lags `delay`ms behind the source.
 *
 * Used to prevent fetch storms on forms with multiple cascading effects
 * (e.g. /bookings/new, where picking a customer triggers 2-3 API calls
 * and the user might change their selection mid-load).
 *
 * Pattern:
 *   const debouncedLeadId = useDebounced(leadId, 250);
 *   useEffect(() => { fetch(...) }, [debouncedLeadId]);
 *
 * The cleanup runs on every change so a fast sequence of updates only
 * fires the effect once with the final value.
 */

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
