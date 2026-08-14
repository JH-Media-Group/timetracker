import { Suspense } from "react";
import { ConfigureClient } from "./configure-client";

/**
 * `useSearchParams` needs a Suspense boundary or the whole route opts out of
 * static rendering, which Next reports at build time rather than at runtime.
 */
export default function ConfigurePage() {
  return (
    <Suspense fallback={null}>
      <ConfigureClient />
    </Suspense>
  );
}
