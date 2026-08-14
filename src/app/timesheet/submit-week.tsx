"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Send } from "lucide-react";
import * as api from "@/lib/api";
import { Button, Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { useApp } from "@/components/app/providers";

/** Submit-for-approval control. Reflects the submission state rather than
 *  disappearing, so someone can see that a week was already approved. */
export function SubmitWeek({ userId, weekStart, totalSeconds }: {
  userId: string; weekStart: string; totalSeconds: number;
}) {
  const { settings } = useApp();
  const qc = useQueryClient();
  const toast = useToast();

  const { data: submissions = [] } = useQuery({ queryKey: ["submissions"], queryFn: api.listSubmissions });
  const sub = submissions.find((s) => s.userId === userId && s.periodStart === weekStart);

  const submit = useMutation({
    mutationFn: () => api.submitTimesheet(userId, weekStart),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["submissions"] });
      toast.push({ tone: "success", title: "Timesheet submitted for approval." });
    },
  });

  if (!settings.modules?.approvals) return null;
  if (sub?.state === "approved") return <Badge variant="success" dot>Approved</Badge>;
  if (sub?.state === "submitted") return <Badge variant="warning" dot>Awaiting review</Badge>;

  return (
    <Button variant={sub?.state === "changes_requested" ? "secondary" : "secondary"} size="md"
      loading={submit.isPending} disabled={totalSeconds === 0} onClick={() => submit.mutate()}>
      {sub?.state === "changes_requested" ? "Resubmit week" : <><Send className="size-3.5" />Submit week</>}
    </Button>
  );
}
