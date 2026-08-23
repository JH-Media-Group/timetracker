"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ClientEditor } from "../../client-editor";

/**
 * The Suspense boundary is for `useSearchParams` inside the editor, which is
 * called unconditionally even here where the `?next=` hop is not offered:
 * calling a hook only on one branch is how a hooks-order crash gets shipped.
 */
export default function EditClientPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={null}>
      <ClientEditor clientId={id} />
    </Suspense>
  );
}
