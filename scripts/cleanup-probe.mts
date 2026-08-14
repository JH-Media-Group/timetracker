/** Removes the rows an automated interaction pass leaves behind. Dev only. */
import { sql } from "drizzle-orm";
import { db } from "../src/server/db/client";

const counts: Record<string, number> = {};
counts.entries = (await db.execute(sql`DELETE FROM time_entries WHERE notes LIKE '%wiring probe%'`)).length;
counts.invoiceProjects = (await db.execute(sql`DELETE FROM invoice_projects WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '%Wiring probe%')`)).length;
counts.projectTasks = (await db.execute(sql`DELETE FROM project_tasks WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '%Wiring probe%')`)).length;
counts.projectMembers = (await db.execute(sql`DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '%Wiring probe%')`)).length;
counts.projects = (await db.execute(sql`DELETE FROM projects WHERE name LIKE '%Wiring probe%'`)).length;
counts.tasks = (await db.execute(sql`DELETE FROM tasks WHERE name LIKE '%Wiring probe%'`)).length;
counts.clients = (await db.execute(sql`DELETE FROM clients WHERE name LIKE '%Probe%'`)).length;
counts.categories = (await db.execute(sql`DELETE FROM expense_categories WHERE name LIKE 'Sweep %'`)).length;
console.log("probe rows removed:", counts);
process.exit(0);
