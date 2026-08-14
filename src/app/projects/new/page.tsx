"use client";

import { Suspense } from "react";
import { ProjectEditor } from "../project-editor";

/**
 * `useSearchParams` needs a Suspense boundary, and the editor reads `?client=`
 * so that starting a project from a client page does not then ask which client.
 */
export default function NewProjectPage() {
  return (
    <Suspense fallback={null}>
      <ProjectEditor />
    </Suspense>
  );
}
