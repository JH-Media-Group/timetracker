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
 *
 * The decision about what a failure means is in `src/lib/sign-out.ts`, shared
 * with the account menu so the two cannot drift: the session ends when the
 * server says it ended, and until then this page says so rather than showing
 * the sign-in screen over a session that is still live.
 */

import * as React from "react";
import * as api from "@/lib/api";
import { endSession } from "@/lib/sign-out";
import { Button, Spinner } from "@/components/ui/primitives";

export default function LogoutPage() {
  const [failure, setFailure] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(true);

  const run = React.useCallback(async () => {
    setWorking(true);
    setFailure(null);
    // A full document load rather than a router navigation, so the React Query
    // cache holding the previous person's data is discarded rather than handed
    // to whoever is at the keyboard next.
    const message = await endSession({
      signOut: api.signOut,
      leave: () => window.location.assign("/signin"),
    });
    setFailure(message);
    setWorking(false);
  }, []);

  React.useEffect(() => {
    void run();
  }, [run]);

  return (
    <main className="grid min-h-screen place-items-center p-5">
      {failure ? (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="text-base text-ink">{failure}</div>
          <Button variant="primary" onClick={() => void run()} loading={working}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-base text-ink-secondary">
          <Spinner className="size-4" />
          Signing you out...
        </div>
      )}
    </main>
  );
}
