"use client";

import { useParams } from "next/navigation";
import { ProjectEditor } from "../../project-editor";

export default function EditProjectPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectEditor projectId={id} />;
}
