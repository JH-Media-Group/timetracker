"use client";

import { useParams } from "next/navigation";
import { ClientEditor } from "../../client-editor";

export default function EditClientPage() {
  const { id } = useParams<{ id: string }>();
  return <ClientEditor clientId={id} />;
}
