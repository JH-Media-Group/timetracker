"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import type { PermissionProfile, User } from "@/lib/types";
import { Button, Card, Field, Input, Select } from "@/components/ui/primitives";
import { TimeZonePicker } from "@/components/app/timezone-picker";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { useToast } from "@/components/ui/toast";

export default function NewPersonPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = React.useState({
    firstName: "", lastName: "", email: "", employmentType: "employee" as User["employmentType"],
    timezone: "America/New_York", capacityHours: "40", profile: "member" as PermissionProfile,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: () => api.createUser({
      firstName: form.firstName.trim(), lastName: form.lastName.trim(),
      email: form.email.trim().toLowerCase(), timezone: form.timezone,
      weeklyCapacitySeconds: Math.round(Number(form.capacityHours) * 3600),
      employmentType: form.employmentType, profile: form.profile,
    }),
    onSuccess: (user) => {
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
      toast.push({ tone: "success", title: `${user.firstName} was added. You can now send their invitation.` });
      router.push(`/team/${user.id}`);
    },
    onError: (error) => toast.push({ tone: "danger", title: error instanceof Error ? error.message : "Could not add that person." }),
  });
  const valid = form.firstName.trim() && form.lastName.trim() && form.email.trim() &&
    Number.isFinite(Number(form.capacityHours)) && Number(form.capacityHours) >= 0 && Number(form.capacityHours) <= 168;

  return <>
    <PageHeader breadcrumb={[{ label: "Team", href: "/team" }]} title="Add person" actions={<>
      <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
      <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Add person</Button>
    </>} />
    <PageBody className="max-w-[800px] pt-5"><Card><div className="grid gap-4 md:grid-cols-2">
      <Field label="First name" required><Input autoFocus value={form.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field>
      <Field label="Last name" required><Input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} /></Field>
      <Field label="Email" required className="md:col-span-2"><Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
      <Field label="Employment"><Select value={form.employmentType} onChange={(e) => set("employmentType", e.target.value as User["employmentType"])}><option value="employee">Employee</option><option value="contractor">Contractor</option></Select></Field>
      <Field label="Capacity" help="Hours per week"><Input inputMode="decimal" value={form.capacityHours} onChange={(e) => set("capacityHours", e.target.value)} /></Field>
      <Field
        label="Time zone"
        htmlFor="person-timezone"
        help="Uses regional IANA rules, including daylight-saving changes. Cancun currently stays UTC-5 year-round."
      >
        <TimeZonePicker
          id="person-timezone"
          value={form.timezone}
          onChange={(timezone) => set("timezone", timezone)}
        />
      </Field>
      <Field label="Permission profile"><Select value={form.profile} onChange={(e) => set("profile", e.target.value as PermissionProfile)}>{api.permissionProfiles().map((p) => <option key={p.id} value={p.key}>{p.name}</option>)}</Select></Field>
    </div></Card></PageBody>
  </>;
}
