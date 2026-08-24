/**
 * The Tally MCP server.
 *
 * Every tool calls a service function through a real Ctx, in the same way the
 * web app's route handlers do. No tool touches Drizzle directly, and no tool
 * re-implements a rule. That is the one architectural constraint in MCP-PRD
 * section 2, and the test in section 8 asserts it.
 *
 * Tools are grouped by the PRD's step order. Step 1 (this file's initial
 * content) is read-only: the whole authorization surface, with nothing to undo
 * if it is wrong.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolCtx } from "./context.js";
import { listProjects } from "@/server/services/projects";
import { listTasks } from "@/server/services/tasks";
import { listClients } from "@/server/services/clients";
import {
  listTimeEntries,
  runningEntry,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  stopTimer,
} from "@/server/services/time";
import { submitTimesheet } from "@/server/services/approvals";
import { timeReport } from "@/server/services/reports";
import { addDays, startOfWeek } from "@/domain/calendar";
import { AppError } from "@/server/errors";

export const mcpServer = new McpServer({
  name: "tally",
  version: "0.1.0",
});

/* ----------------------------------------------------------------- helpers */

/** Today in YYYY-MM-DD, in the actor's timezone if possible. */
function today(tz = "UTC"): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}

/** Catch AppErrors and return them as MCP error content. */
async function safe<T>(fn: () => Promise<T>): Promise<{ content: { type: "text"; text: string }[] }> {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    if (e instanceof AppError) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: e.code, detail: e.message, ...(e.fieldErrors ? { fields: e.fieldErrors } : {}) }),
        }],
      };
    }
    throw e;
  }
}

/* ================================================= Step 1: read-only tools */

mcpServer.tool(
  "tally_projects_mine",
  "List the projects and tasks you can book time to. Returns each project with its name, client, and the tasks available on it. Call this first to get IDs for other tools.",
  {},
  async () => {
    const ctx = toolCtx();
    return safe(async () => {
      const [projects, tasks, clients] = await Promise.all([
        listProjects(ctx),
        listTasks(ctx),
        listClients(ctx),
      ]);

      const taskMap = new Map(tasks.map((t) => [t.id, t]));
      const clientMap = new Map(clients.map((c) => [c.id, c]));

      return projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          client: clientMap.get(p.clientId)?.name ?? null,
          clientId: p.clientId,
          tasks: p.taskIds
            .map((tid) => taskMap.get(tid))
            .filter(Boolean)
            .filter((t) => !t!.archivedAt)
            .map((t) => ({ id: t!.id, name: t!.name, defaultBillable: t!.defaultBillable })),
        }));
    });
  }
);

mcpServer.tool(
  "tally_time_list",
  "List time entries for a date range. Defaults to this week (Monday to Sunday). Optionally filter by project, task, or another user (if you have permission). Returns duration, project, task, notes, and billing info.",
  {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("Start date (YYYY-MM-DD). Defaults to Monday of this week."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("End date (YYYY-MM-DD). Defaults to Sunday of this week."),
    userId: z.string().uuid().optional()
      .describe("Another user's ID. Requires time:view_others and reach."),
    projectId: z.string().uuid().optional()
      .describe("Filter to a specific project."),
    limit: z.number().int().min(1).max(1000).optional()
      .describe("Maximum entries to return. Defaults to 200."),
  },
  async ({ from, to, userId, projectId, limit }) => {
    const ctx = toolCtx();
    return safe(async () => {
      const t = today(ctx.actor.timezone);
      const weekStart = startOfWeek(t, 1);
      const weekEnd = addDays(weekStart, 6);

      return listTimeEntries(ctx, {
        from: from ?? weekStart,
        to: to ?? weekEnd,
        userId,
        projectId,
        limit: limit ?? 200,
      });
    });
  }
);

mcpServer.tool(
  "tally_timer_current",
  "Check if you have a running timer. Returns the time entry with its current elapsed duration, or null if nothing is running.",
  {},
  async () => {
    const ctx = toolCtx();
    return safe(async () => {
      const entry = await runningEntry(ctx);
      if (!entry) return { running: false };

      const elapsed = entry.timerStartedAt
        ? Math.floor((Date.now() - new Date(entry.timerStartedAt).getTime()) / 1000) + entry.durationSeconds
        : entry.durationSeconds;

      return {
        running: true,
        entry,
        elapsedSeconds: elapsed,
        elapsedFormatted: formatDuration(elapsed),
      };
    });
  }
);

mcpServer.tool(
  "tally_report_time",
  "Run a time report grouped by client, project, task, or user. Returns totals for tracked hours, billable hours, and amounts (if you have billing permissions). Useful for answering questions like 'how much time did I spend on X this month'.",
  {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Start date (YYYY-MM-DD). Required."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("End date (YYYY-MM-DD). Required."),
    groupBy: z.enum(["client", "project", "task", "user"]).optional()
      .describe("How to group results. Defaults to 'project'."),
    userId: z.string().uuid().optional()
      .describe("Filter to a specific user."),
    projectId: z.string().uuid().optional()
      .describe("Filter to a specific project."),
    clientId: z.string().uuid().optional()
      .describe("Filter to a specific client."),
  },
  async ({ from, to, groupBy, userId, projectId, clientId }) => {
    const ctx = toolCtx();
    return safe(async () => {
      return timeReport(ctx, {
        from,
        to,
        groupBy: groupBy ?? "project",
        userId,
        projectId,
        clientId,
      });
    });
  }
);

/* ----------------------------------------------------------------- format */

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/* =========================================== Step 2: timer and time writes */

mcpServer.tool(
  "tally_timer_start",
  "Start a timer on a project and task. Only one timer can run at a time per person, so if another timer is already running it will be stopped first. The response tells you what was stopped and what was started.",
  {
    projectId: z.string().uuid()
      .describe("The project to track time against. Get IDs from tally_projects_mine."),
    taskId: z.string().uuid()
      .describe("The task within the project. Get IDs from tally_projects_mine."),
    notes: z.string().optional()
      .describe("Optional notes describing what you are working on."),
  },
  async ({ projectId, taskId, notes }) => {
    const ctx = toolCtx();
    return safe(async () => {
      const { entry, stopped } = await createTimeEntry(ctx, {
        projectId,
        taskId,
        notes: notes ?? null,
        start: true,
        source: "mcp",
      });
      return {
        started: entry,
        stopped: stopped
          ? { id: stopped.id, durationSeconds: stopped.durationSeconds, duration: formatDuration(stopped.durationSeconds) }
          : null,
        message: stopped
          ? `Started timer. Stopped previous timer (${formatDuration(stopped.durationSeconds)}).`
          : "Timer started.",
      };
    });
  }
);

mcpServer.tool(
  "tally_timer_stop",
  "Stop your currently running timer. Returns the stopped entry with its final duration, or a message that nothing was running.",
  {},
  async () => {
    const ctx = toolCtx();
    return safe(async () => {
      const entry = await stopTimer(ctx);
      if (!entry) return { stopped: false, message: "No timer was running." };
      return {
        stopped: true,
        entry,
        duration: formatDuration(entry.durationSeconds),
        message: `Stopped timer: ${formatDuration(entry.durationSeconds)}.`,
      };
    });
  }
);

mcpServer.tool(
  "tally_time_log",
  "Log a completed time entry with a known duration (no timer). Use this when you already know how long something took.",
  {
    projectId: z.string().uuid()
      .describe("The project to log time against. Get IDs from tally_projects_mine."),
    taskId: z.string().uuid()
      .describe("The task within the project. Get IDs from tally_projects_mine."),
    spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("The date to log the time on (YYYY-MM-DD). Defaults to today."),
    durationSeconds: z.number().int().min(0).optional()
      .describe("Duration in seconds. Provide this OR hours, not both."),
    hours: z.number().min(0).optional()
      .describe("Duration in hours (e.g. 1.5 for 1h 30m). Converted to seconds internally. Provide this OR durationSeconds."),
    notes: z.string().optional()
      .describe("Optional notes describing the work."),
    isBillable: z.boolean().optional()
      .describe("Whether this time is billable. Defaults to the task's default."),
  },
  async ({ projectId, taskId, spentOn, durationSeconds, hours, notes, isBillable }) => {
    const ctx = toolCtx();
    return safe(async () => {
      const dur = durationSeconds ?? (hours != null ? Math.round(hours * 3600) : undefined);
      if (dur == null || dur <= 0) {
        throw new AppError("validation_failed", "Provide durationSeconds or hours (must be > 0).");
      }
      const { entry } = await createTimeEntry(ctx, {
        projectId,
        taskId,
        spentOn: spentOn ?? today(ctx.actor.timezone),
        durationSeconds: dur,
        notes: notes ?? null,
        isBillable,
        source: "mcp",
      });
      return {
        entry,
        duration: formatDuration(entry.durationSeconds),
        message: `Logged ${formatDuration(entry.durationSeconds)}.`,
      };
    });
  }
);

mcpServer.tool(
  "tally_time_edit",
  "Edit an existing time entry. Only the fields you provide will change; omitted fields stay as they are. You can change the project, task, date, duration, notes, or billable flag.",
  {
    id: z.string().uuid()
      .describe("The ID of the time entry to edit. Get IDs from tally_time_list."),
    projectId: z.string().uuid().optional()
      .describe("Move the entry to a different project."),
    taskId: z.string().uuid().optional()
      .describe("Change the task. If you also change the project, this must be a task on the new project."),
    spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("Change the date (YYYY-MM-DD)."),
    durationSeconds: z.number().int().min(0).optional()
      .describe("Change the duration in seconds."),
    notes: z.string().nullable().optional()
      .describe("Change the notes. Pass null to clear them."),
    isBillable: z.boolean().optional()
      .describe("Change whether this entry is billable."),
  },
  async ({ id, projectId, taskId, spentOn, durationSeconds, notes, isBillable }) => {
    const ctx = toolCtx();
    return safe(async () => {
      const entry = await updateTimeEntry(ctx, id, {
        projectId,
        taskId,
        spentOn,
        durationSeconds,
        notes,
        isBillable,
      });
      return {
        entry,
        message: `Updated entry (${formatDuration(entry.durationSeconds)}).`,
      };
    });
  }
);

mcpServer.tool(
  "tally_time_delete",
  "Soft-delete a time entry. The entry can be restored later with its ID. Returns the ID for reference.",
  {
    id: z.string().uuid()
      .describe("The ID of the time entry to delete. Get IDs from tally_time_list."),
  },
  async ({ id }) => {
    const ctx = toolCtx();
    return safe(async () => {
      await deleteTimeEntry(ctx, id);
      return {
        deletedId: id,
        message: "Entry deleted. It can be restored if needed.",
      };
    });
  }
);

mcpServer.tool(
  "tally_week_submit",
  "Submit a week's timesheet for approval. The week must start on a Monday. Once submitted, the entries for that week are locked until the submission is approved or changes are requested.",
  {
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("The Monday that starts the week to submit (YYYY-MM-DD). Must be a Monday."),
  },
  async ({ weekStart }) => {
    const ctx = toolCtx();
    return safe(async () => {
      const submission = await submitTimesheet(ctx, { periodStart: weekStart });
      return {
        submission,
        message: `Week of ${weekStart} submitted for approval.`,
      };
    });
  }
);
