"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ClientEditor } from "../../client-editor";

/**
 * The Suspense boundary is what Next requires of any tree reading
 * `useSearchParams`, which `ClientForm` does even here, where the `?next=` hop
 * is never offered.
 *
 * An earlier version of this comment gave a hooks-order argument instead. It
 * was wrong twice: the hook is in `ClientForm`, a different component, so there
 * is no ordering hazard between them, and `ClientEditor` returns early while
 * the bootstrap loads, so it is not called unconditionally either. A reviewer
 * caught both. The real reason is the prerender bailout, and `fallback={null}`
 * means this page prerenders to nothing, which is fine for a form behind auth.
 */
export default function EditClientPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={null}>
      <ClientEditor clientId={id} />
    </Suspense>
  );
}
