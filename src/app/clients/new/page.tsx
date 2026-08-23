"use client";

import { Suspense } from "react";
import { ClientEditor } from "../client-editor";

/**
 * `useSearchParams` needs a Suspense boundary, and the editor reads `?next=`
 * so that "Add new client" from the project form comes back to that form with
 * the client it just made already chosen.
 */
export default function NewClientPage() {
  return (
    <Suspense fallback={null}>
      <ClientEditor />
    </Suspense>
  );
}
