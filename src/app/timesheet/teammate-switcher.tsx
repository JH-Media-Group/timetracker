"use client";

import * as React from "react";
import { ChevronDown, Check } from "lucide-react";
import { Avatar, Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { useApp, useCan } from "@/components/app/providers";

/** Track on behalf of a teammate. Only rendered for profiles that may edit
 *  others' time; selecting someone raises the unmissable banner on the page. */
export function TeammateSwitcher({ userId, onChange }: { userId: string; onChange: (id: string) => void }) {
  const { users, me, userById } = useApp();
  const can = useCan();
  const [open, setOpen] = React.useState(false);
  if (!can("time:view_others")) return null;

  const current = userById.get(userId);
  const employees = users.filter((u) => u.employmentType === "employee" && !u.archivedAt);
  const contractors = users.filter((u) => u.employmentType === "contractor" && !u.archivedAt);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="md" className="gap-2">
          {userId === me.id ? "Me" : `${current?.firstName} ${current?.lastName}`}
          <ChevronDown className="size-3.5 text-ink-tertiary" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-1.5" align="end">
        <Row user={me} label="Me" selected={userId === me.id} onSelect={() => { onChange(me.id); setOpen(false); }} />
        <div className="my-1.5 h-px bg-border" />
        {[["Employees", employees], ["Contractors", contractors]].map(([label, list]) => (
          <div key={label as string}>
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">{label as string}</div>
            {(list as typeof users).filter((u) => u.id !== me.id).map((u) => (
              <Row key={u.id} user={u} selected={userId === u.id} onSelect={() => { onChange(u.id); setOpen(false); }} />
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Row({ user, label, selected, onSelect }: {
  user: Parameters<typeof Avatar>[0]["user"]; label?: string; selected?: boolean; onSelect: () => void;
}) {
  return (
    <button onClick={onSelect} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base hover:bg-surface-hover">
      <Avatar user={user} size="sm" />
      <span className="min-w-0 flex-1 truncate">{label ?? `${user.firstName} ${user.lastName}`}</span>
      {selected && <Check className="size-4 shrink-0" strokeWidth={3} />}
    </button>
  );
}
