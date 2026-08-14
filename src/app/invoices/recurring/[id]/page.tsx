"use client";

import { useParams } from "next/navigation";
import { RecurringEditor } from "../../recurring-editor";

export default function EditRecurringPage() {
  const { id } = useParams<{ id: string }>();
  return <RecurringEditor scheduleId={id} />;
}
