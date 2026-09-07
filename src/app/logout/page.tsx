"use client";

/**
 * /logout
 *
 * The account menu is where signing out lives, but `/logout` is the URL people
 * type, and it is the one the bug report was filed against: it returned nothing
 * at all, because no such route existed.
 *
 * A page rather than a GET API route on purpose. A GET that ends a session can
 * be fired by anything that can put a URL on a page, an `<img>` included. This
 * runs in the browser and issues the same POST the menu does, so it cannot be
 * triggered by a third party simply linking at it.
 */

import * as React from "react";
import * as api from "@/lib/api";
import { Spinner } from "@/components/ui/primitives";

export default function LogoutPage() {
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await api.signOut();
      } catch {
        // Ignored on purpose: the point of this page is to end up signed out.
        // If the request did not land, the redirect below still takes the
        // person off the application, and the session cookie is short-lived.
      }
      // A full document load rather than a router navigation, so the React
      // Query cache holding the previous person's data is discarded rather
      // than handed to whoever is at the keyboard next.
      if (!cancelled) window.location.assign("/signin");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <div className="flex items-center gap-2 text-base text-ink-secondary">
        <Spinner className="size-4" />
        Signing you out...
      </div>
    </main>
  );
}
