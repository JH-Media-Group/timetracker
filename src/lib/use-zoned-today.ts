"use client";

import * as React from "react";
import { dayIn } from "@/domain/calendar";

/**
 * The current calendar day in a named timezone, kept fresh across midnight.
 *
 * Long-lived timesheet tabs are normal. Refresh on a short interval and as soon
 * as a background tab becomes active, so "today" cannot remain yesterday just
 * because the application shell was mounted before midnight.
 */
export function useZonedToday(timezone: string): string {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const refresh = () => setNow(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [timezone]);

  return dayIn(timezone, new Date(now));
}
