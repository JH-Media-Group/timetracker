"use client";

/**
 * Person editor.
 *
 * The screen TALLY-6 was about. "Edit person" on a teammate used to navigate to
 * the People settings page, from which clicking the person returned to the
 * read-only detail view, so there was no way round the loop and no way to
 * correct a name, move somebody between employee and contractor, change what
 * they can do, or take a departed contractor off the roster.
 *
 * Three cards, in the order somebody actually edits them: who they are, how
 * they work, and what they may do. Removal sits at the bottom on its own,
 * because it is the one action here that takes something away.
 *
 * Every rule this form appears to enforce is enforced again in
 * `src/server/services/people.ts`, and the server is the one that counts. What
 * the form does is avoid offering an action that would be refused, which is a
 * courtesy rather than a control.
 */

import * as React from "react";
import { RatesPanel } from "@/components/app/rates-panel";
import { TimeZonePicker } from "@/components/app/timezone-picker";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as api from "@/lib/api";
import type { PermissionProfile, User } from "@/lib/types";
import {
  Badge, Button, Card, EmptyState, Field, Input, Select, Spinner,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { SectionTitle } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";

const PROFILE_LABEL: Record<PermissionProfile, string> = {
  member: "Member",
  project_manager: "Project Manager",
  people_admin: "People Admin",
  accounting: "Accounting",
  executive_manager: "Executive Manager",
  administrator: "Administrator",
};

/** Hours a week, as a person would type it, in the seconds the API wants. */
const toSeconds = (hours: string) => Math.round(Number(hours) * 3600);
const toHours = (seconds: number) => String(Math.round((seconds / 3600) * 100) / 100);

/**
 * The record has to be in hand before the form mounts.
 *
 * Field state is initialised once from `existing`, so mounting during the
 * bootstrap fetch would leave every input blank and then save those blanks over
 * a real person. Same rule as `ClientEditor`, and it is written down in both
 * places because it is the kind of thing that gets refactored away.
 */
export function PersonEditor({ personId }: { personId: string }) {
  const router = useRouter();
  const { users, ready } = useApp();
  const existing = users.find((u) => u.id === personId);

  if (!existing) {
    return (
      <PageBody className="pt-10">
        {ready ? (
          <EmptyState
            title="Person not found."
            action={<Button onClick={() => router.push("/team")}>Back to team</Button>}
          >
            They may have been removed, or the link may be wrong.
          </EmptyState>
        ) : (
          <div className="flex items-center gap-2 text-base text-ink-secondary">
            <Spinner className="size-4" />
            Loading the person…
          </div>
        )}
      </PageBody>
    );
  }

  return <PersonForm existing={existing} />;
}

function PersonForm({ existing }: { existing: User }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const { me } = useApp();

  const [form, setForm] = React.useState(() => ({
    firstName: existing.firstName,
    lastName: existing.lastName,
    email: existing.email,
    employmentType: existing.employmentType,
    timezone: existing.timezone,
    capacityHours: toHours(existing.weeklyCapacitySeconds),
    profile: existing.profile,
    roles: existing.roles.join(", "),
    departments: existing.departments.join(", "),
    startedOn: existing.startedOn ?? "",
  }));

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isSelf = me?.id === existing.id;
  const canManage = can("people:manage");

  /**
   * What the server will refuse, mirrored so the form does not offer it.
   *
   * The owner's record is theirs alone, and nobody changes their own
   * permissions: self-promotion needs a second person even when the rank rule
   * would allow it. Both of these are enforced in `people.ts`; disabling the
   * control here just means nobody types into a field that will bounce.
   */
  const ownerLocked = Boolean(existing.isOwner) && !isSelf;
  const profileLocked = ownerLocked || isSelf || !canManage;

  /*
    A pending rate edit from the card below, so "Save changes" saves it too.

    The rates live in their own table behind their own endpoint, and this form
    posts to `updateUser`, which carries none of them. So the page header's
    Save quietly skipped the two money fields on the same page and reported
    success: the audit for the day Person02 reported it showed two user.update
    rows and no rate.set at all (t-VFx9pa).

    A button labelled "Save changes" saves the changes on the page. The rates
    go first, because they are the part somebody came to this screen to change
    and the part that must not be silently dropped.
  */
  const pendingRates = React.useRef<(() => Promise<void>) | null>(null);
  const onPendingRates = React.useCallback((commit: (() => Promise<void>) | null) => {
    pendingRates.current = commit;
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      const list = (v: string) =>
        v.split(",").map((x) => x.trim()).filter(Boolean);

      if (pendingRates.current) await pendingRates.current();

      return api.updateUser(existing.id, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
        employmentType: form.employmentType,
        timezone: form.timezone,
        weeklyCapacitySeconds: toSeconds(form.capacityHours || "0"),
        roles: list(form.roles),
        departments: list(form.departments),
        startedOn: form.startedOn || undefined,
        // Only when it actually moved. Sending the current value would make
        // every save a permission change, which the server audits as one and
        // refuses when the actor may not grant it.
        profile: form.profile === existing.profile ? undefined : form.profile,
      });
    },
    onSuccess: (user) => {
      // Seed the cached bootstrap before navigating, so the detail page has the
      // new values on its first render rather than showing the old ones for a
      // beat while a refetch lands.
      qc.setQueryData(["bootstrap"], (old: { users?: User[] } | undefined) => {
        if (!old?.users) return old;
        return { ...old, users: old.users.map((u) => (u.id === user.id ? user : u)) };
      });
      toast.push({ tone: "success", title: "Person updated." });
      router.push(`/team/${user.id}`);
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: (error: unknown) => {
      toast.push({
        tone: "danger",
        title: error instanceof Error ? `Could not save. ${error.message}` : "Could not save.",
      });
    },
  });

  const canSave =
    form.firstName.trim().length > 0 &&
    form.lastName.trim().length > 0 &&
    form.email.trim().length > 0 &&
    !Number.isNaN(Number(form.capacityHours || "0"));

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: `${existing.firstName} ${existing.lastName}`, href: `/team/${existing.id}` },
        ]}
        title="Edit person"
        actions={
          <>
            <Button variant="ghost" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canSave}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save changes
            </Button>
          </>
        }
      />

      <PageBody className="max-w-[1000px] pt-5">
        <div className="flex flex-col gap-4">
          {ownerLocked && (
            <Card className="border-warning-border bg-warning-bg">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <p className="text-base text-ink-secondary">
                  This is the account owner. Only they can change their own record, including
                  their email address, because an account with no owner is one nobody can repair.
                </p>
              </div>
            </Card>
          )}

          <Card>
            <SectionTitle>Who they are</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="First name" required>
                <Input
                  value={form.firstName}
                  onChange={(e) => set("firstName", e.target.value)}
                  disabled={ownerLocked}
                  autoFocus
                />
              </Field>
              <Field label="Last name" required>
                <Input
                  value={form.lastName}
                  onChange={(e) => set("lastName", e.target.value)}
                  disabled={ownerLocked}
                />
              </Field>
              <Field
                label="Email"
                required
                help="This is how they sign in, so changing it changes who can get into the account."
                className="lg:col-span-2"
              >
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  disabled={ownerLocked}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>How they work</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Employment">
                <Select
                  value={form.employmentType}
                  onChange={(e) => set("employmentType", e.target.value as User["employmentType"])}
                  disabled={ownerLocked}
                >
                  <option value="employee">Employee</option>
                  <option value="contractor">Contractor</option>
                </Select>
              </Field>
              <Field label="Capacity" help="Hours a week. Drives the utilisation figure.">
                <Input
                  inputMode="decimal"
                  value={form.capacityHours}
                  onChange={(e) => set("capacityHours", e.target.value)}
                  disabled={ownerLocked}
                />
              </Field>
              <Field
                label="Time zone"
                htmlFor="person-timezone"
                help="Uses regional IANA rules, including daylight-saving changes. Cancun currently stays UTC-5 year-round."
              >
                <TimeZonePicker
                  id="person-timezone"
                  value={form.timezone}
                  onChange={(timezone) => set("timezone", timezone)}
                  disabled={ownerLocked}
                />
              </Field>
              <Field label="Started on">
                <Input
                  type="date"
                  value={form.startedOn}
                  onChange={(e) => set("startedOn", e.target.value)}
                  disabled={ownerLocked}
                />
              </Field>
              <Field label="Roles" help="Comma separated. Used for grouping and blended rates.">
                <Input
                  value={form.roles}
                  onChange={(e) => set("roles", e.target.value)}
                  placeholder="Designer, Developer"
                  disabled={ownerLocked}
                />
              </Field>
              <Field label="Departments" help="Comma separated.">
                <Input
                  value={form.departments}
                  onChange={(e) => set("departments", e.target.value)}
                  placeholder="Studio"
                  disabled={ownerLocked}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>What they may do</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field
                label="Permission profile"
                help={
                  isSelf
                    ? "You cannot change your own permissions. Ask another administrator."
                    : ownerLocked
                      ? "The owner's permissions are fixed."
                      : "The server refuses a profile that grants more than you hold yourself."
                }
              >
                <Select
                  value={form.profile}
                  onChange={(e) => set("profile", e.target.value as PermissionProfile)}
                  disabled={profileLocked}
                >
                  {api.permissionProfiles().map((p) => (
                    <option key={p.id} value={p.key}>
                      {p.name || PROFILE_LABEL[p.key]}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* The field row and control-height wrapper align the badges to
                  the select without a hand-tuned offset. */}
              <Field label="Current access">
                <div className="flex h-9 items-center gap-2">
                  <Badge variant={existing.employmentType === "contractor" ? "warning" : "neutral"}>
                    {existing.employmentType === "contractor" ? "Contractor" : "Employee"}
                  </Badge>
                  <Badge variant={existing.isOwner ? "info" : "neutral"}>
                    {existing.isOwner ? "Owner" : PROFILE_LABEL[existing.profile]}
                  </Badge>
                </div>
              </Field>
            </div>
          </Card>

          {/* Rates are their own card: what somebody is paid is a different
              decision from what they may do, gated by different capabilities,
              and the panel decides for itself what to show. */}
          <RatesPanel userId={existing.id} editable onPendingChange={onPendingRates} />

          {canManage && !existing.isOwner && !isSelf && <RemoveCard person={existing} />}
        </div>
      </PageBody>
    </>
  );
}

/**
 * Removal, which is archiving.
 *
 * Archive over delete, so their tracked hours, their expenses and their name on
 * an old invoice all survive. What archiving does take away is immediate and
 * worth spelling out on the button rather than in a tooltip: they are signed
 * out, their running timer is stopped, and they come off their projects.
 */
function RemoveCard({ person }: { person: User }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const archived = Boolean(person.archivedAt);
  const [confirming, setConfirming] = React.useState(false);

  const act = useMutation({
    mutationFn: () => api.archiveUser(person.id, !archived),
    onSuccess: (user) => {
      qc.setQueryData(["bootstrap"], (old: { users?: User[] } | undefined) => {
        if (!old?.users) return old;
        return { ...old, users: old.users.map((u) => (u.id === user.id ? user : u)) };
      });
      toast.push({
        tone: "success",
        title: archived
          ? "Person restored. They can sign in again."
          : "Removed from the team. Their history is intact, and they can be restored.",
      });
      router.push(`/team/${user.id}`);
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: (error: unknown) => {
      setConfirming(false);
      const what = archived ? "Could not restore." : "Could not remove.";
      toast.push({
        tone: "danger",
        title: error instanceof Error ? `${what} ${error.message}` : what,
      });
    },
  });

  return (
    <Card className={archived ? undefined : "border-danger-border"}>
      <SectionTitle>{archived ? "Restore" : "Remove from the team"}</SectionTitle>

      {archived ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-base text-ink-secondary">
            {person.firstName} was removed from the team and cannot sign in. Restoring them puts
            them back on the roster; their projects are not restored with them.
          </p>
          <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate()}>
            Restore
          </Button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div className="text-base text-ink-secondary">
            <p>
              Their tracked time, expenses, and name on past invoices all stay exactly as they are.
              Nothing is deleted.
            </p>
            <p className="mt-1.5">
              What happens straight away: they are signed out and cannot sign back in, a running
              timer is stopped at this moment, and they come off their projects.
            </p>
          </div>

          {confirming ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="danger" loading={act.isPending} onClick={() => act.mutate()}>
                Yes, remove {person.firstName}
              </Button>
            </div>
          ) : (
            <Button variant="danger" className="shrink-0" onClick={() => setConfirming(true)}>
              Remove from the team
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
