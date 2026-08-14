"use client";

import { useParams } from "next/navigation";
import { PersonEditor } from "../../person-editor";

export default function EditPersonPage() {
  const { id } = useParams<{ id: string }>();
  return <PersonEditor personId={id} />;
}
