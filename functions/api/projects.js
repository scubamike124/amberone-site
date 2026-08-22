import {
  createNotification,
  ensureSchema,
  getUserFromRequest,
  isValidEmail,
  json,
  normalizeEmail,
  nowIso,
  readJson,
  uid,
  writeAudit,
} from "../_lib/core.js";

const ROLES = new Set(["owner", "admin", "member", "viewer"]);
const TASK_STATUS = new Set(["open", "done", "reopened"]);

async function membership(db, projectId, user) {
  return db
    .prepare(
      `SELECT * FROM project_members
       WHERE project_id = ? AND status = 'active'
         AND (user_id = ? OR lower(invited_email) = lower(?))
       LIMIT 1`,
    )
    .bind(projectId, user.id, user.email)
    .first();
}

async function requireMember(db, projectId, user) {
  const row = await membership(db, projectId, user);
  if (!row) return null;
  return row;
}

function canManage(member) {
  return member && (member.role === "owner" || member.role === "admin");
}

async function loadProject(db, projectId, user) {
  const project = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) return null;
  const member = await requireMember(db, projectId, user);
  if (!member) return null;
  const members = await db
    .prepare(
      "SELECT id, project_id, user_id, role, invited_email, status, created_at FROM project_members WHERE project_id = ? ORDER BY created_at",
    )
    .bind(projectId)
    .all();
  const tasks = await db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY position ASC, created_at ASC")
    .bind(projectId)
    .all();
  const comments = await db
    .prepare("SELECT * FROM project_comments WHERE project_id = ? ORDER BY created_at ASC LIMIT 200")
    .bind(projectId)
    .all();
  const messages = await db
    .prepare("SELECT * FROM project_messages WHERE project_id = ? ORDER BY created_at ASC LIMIT 200")
    .bind(projectId)
    .all();
  const files = await db
    .prepare("SELECT id, user_id, project_id, name, content_type, size, created_at, updated_at FROM files WHERE project_id = ? ORDER BY created_at DESC")
    .bind(projectId)
    .all()
    .catch(() => ({ results: [] }));
  return {
    project,
    member,
    members: members.results || [],
    tasks: tasks.results || [],
    comments: comments.results || [],
    messages: messages.results || [],
    files: files.results || [],
  };
}

async function notifyProjectMembers(db, projectId, exceptUserId, payload) {
  const rows = await db
    .prepare("SELECT user_id FROM project_members WHERE project_id = ? AND status = 'active' AND user_id IS NOT NULL")
    .bind(projectId)
    .all();
  for (const row of rows.results || []) {
    if (row.user_id === exceptUserId) continue;
    await createNotification(db, { ...payload, userId: row.user_id });
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const method = request.method;
  const url = new URL(request.url);

  if (method === "GET") {
    const action = url.searchParams.get("action");
    if (action === "invites") {
      const rows = await db
        .prepare(
          `SELECT pm.id, pm.project_id, pm.role, pm.status, pm.created_at, p.name AS project_name
           FROM project_members pm JOIN projects p ON p.id = pm.project_id
           WHERE lower(pm.invited_email) = lower(?) AND pm.status = 'pending'
           ORDER BY pm.created_at DESC`,
        )
        .bind(user.email)
        .all();
      return json({ invites: rows.results || [] });
    }

    const id = url.searchParams.get("id");
    if (id) {
      const packed = await loadProject(db, id, user);
      if (!packed) return json({ error: "Not found" }, 404);
      return json(packed);
    }

    const rows = await db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.status = 'active' AND (pm.user_id = ? OR lower(pm.invited_email) = lower(?))
         ORDER BY p.updated_at DESC`,
      )
      .bind(user.id, user.email)
      .all();
    return json({ projects: rows.results || [] });
  }

  if (method === "POST" || method === "PATCH") {
    const body = await readJson(request);
    const action = String(body.action || (method === "POST" && !body.id ? "create" : "") || "");

    if (action === "create" || (method === "POST" && !body.action && !body.id && body.name)) {
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "name is required" }, 400);
      const id = uid("proj");
      const now = nowIso();
      await db
        .prepare(
          "INSERT INTO projects (id, owner_user_id, team_id, name, description, deadline, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(id, user.id, body.team_id || null, name.slice(0, 200), body.description || null, body.deadline || null, "active", now, now)
        .run();
      await db
        .prepare(
          "INSERT INTO project_members (id, project_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(uid("pm"), id, user.id, "owner", user.email, "active", now)
        .run();
      await writeAudit(db, { userId: user.id, action: "project.create", resourceType: "project", resourceId: id });
      return json(await loadProject(db, id, user), 201);
    }

    if (action === "invite") {
      const member = await requireMember(db, body.project_id, user);
      if (!canManage(member)) return json({ error: "Not found" }, 404);
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return json({ error: "A valid email address is required" }, 400);
      const role = ["admin", "member", "viewer"].includes(String(body.role)) ? String(body.role) : "member";
      const existing = await db
        .prepare("SELECT id, status FROM project_members WHERE project_id = ? AND lower(invited_email) = lower(?) LIMIT 1")
        .bind(body.project_id, email)
        .first();
      if (existing && existing.status !== "rejected") {
        return json({ error: "That person is already invited or is a member" }, 409);
      }
      const id = existing?.id || uid("pm");
      if (existing) {
        await db
          .prepare("UPDATE project_members SET role = ?, status = 'pending', user_id = NULL, created_at = ? WHERE id = ?")
          .bind(role, nowIso(), id)
          .run();
      } else {
        await db
          .prepare(
            "INSERT INTO project_members (id, project_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)",
          )
          .bind(id, body.project_id, null, role, email, "pending", nowIso())
          .run();
      }
      const project = await db.prepare("SELECT name FROM projects WHERE id = ?").bind(body.project_id).first();
      const account = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (account) {
        await createNotification(db, {
          userId: account.id,
          kind: "invite",
          title: `Project invite: ${project?.name || "AmberOne"}`,
          body: `${user.name || user.email} invited you as ${role}.`,
          href: "/dashboard/projects",
        });
      }
      await writeAudit(db, { userId: user.id, action: "project.invite", resourceType: "project", resourceId: body.project_id });
      return json({ id, status: "pending" });
    }

    if (action === "accept" || action === "reject") {
      const invite = await db.prepare("SELECT * FROM project_members WHERE id = ?").bind(body.member_id).first();
      if (!invite || invite.status !== "pending") return json({ error: "Invite not found" }, 404);
      if (normalizeEmail(invite.invited_email) !== normalizeEmail(user.email)) {
        return json({ error: "This invite belongs to a different email address" }, 403);
      }
      if (action === "reject") {
        await db.prepare("UPDATE project_members SET status = 'rejected' WHERE id = ?").bind(invite.id).run();
        return json({ ok: true, status: "rejected" });
      }
      await db.prepare("UPDATE project_members SET user_id = ?, status = 'active' WHERE id = ?").bind(user.id, invite.id).run();
      const project = await db.prepare("SELECT owner_user_id, name FROM projects WHERE id = ?").bind(invite.project_id).first();
      if (project?.owner_user_id) {
        await createNotification(db, {
          userId: project.owner_user_id,
          kind: "invite",
          title: `${user.name || user.email} joined ${project.name}`,
          href: "/dashboard/projects",
        });
      }
      return json({ ok: true, status: "active" });
    }

    if (action === "update") {
      const member = await requireMember(db, body.id || body.project_id, user);
      if (!canManage(member)) return json({ error: "Not found" }, 404);
      const id = body.id || body.project_id;
      const existing = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
      if (!existing) return json({ error: "Not found" }, 404);
      await db
        .prepare(
          `UPDATE projects SET
            name = COALESCE(?, name),
            description = COALESCE(?, description),
            deadline = COALESCE(?, deadline),
            status = COALESCE(?, status),
            updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          body.name !== undefined ? String(body.name).slice(0, 200) : null,
          body.description !== undefined ? body.description : null,
          body.deadline !== undefined ? body.deadline : null,
          body.status !== undefined ? body.status : null,
          nowIso(),
          id,
        )
        .run();
      return json(await loadProject(db, id, user));
    }

    if (action === "task") {
      const member = await requireMember(db, body.project_id, user);
      if (!member || member.role === "viewer") return json({ error: "Not found" }, 404);
      const title = String(body.title || "").trim();
      if (!title) return json({ error: "title is required" }, 400);
      const id = uid("ptask");
      const now = nowIso();
      await db
        .prepare(
          "INSERT INTO project_tasks (id, project_id, assigned_user_id, title, body, due_at, status, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          body.project_id,
          body.assigned_user_id || null,
          title.slice(0, 200),
          body.body || body.description || null,
          body.due_at || body.deadline || null,
          "open",
          Number(body.position) || 0,
          now,
          now,
        )
        .run();
      await db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now, body.project_id).run();
      if (body.assigned_user_id && body.assigned_user_id !== user.id) {
        await createNotification(db, {
          userId: body.assigned_user_id,
          kind: "task",
          title: `Assigned: ${title}`,
          href: "/dashboard/projects",
        });
      }
      return json({ id, status: "open" }, 201);
    }

    if (action === "task_update") {
      const task = await db.prepare("SELECT * FROM project_tasks WHERE id = ?").bind(body.task_id || body.id).first();
      if (!task) return json({ error: "Task not found" }, 404);
      const member = await requireMember(db, task.project_id, user);
      if (!member || member.role === "viewer") return json({ error: "Not found" }, 404);
      const status = body.status !== undefined ? String(body.status) : undefined;
      if (status && !TASK_STATUS.has(status) && status !== "done" && status !== "open") {
        return json({ error: "Invalid task status" }, 400);
      }
      const mapped = status === "complete" || status === "completed" ? "done" : status;
      await db
        .prepare(
          `UPDATE project_tasks SET
            title = COALESCE(?, title),
            body = COALESCE(?, body),
            due_at = COALESCE(?, due_at),
            assigned_user_id = COALESCE(?, assigned_user_id),
            status = COALESCE(?, status),
            updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          body.title !== undefined ? String(body.title).slice(0, 200) : null,
          body.body !== undefined ? body.body : body.description !== undefined ? body.description : null,
          body.due_at !== undefined ? body.due_at : null,
          body.assigned_user_id !== undefined ? body.assigned_user_id : null,
          mapped || null,
          nowIso(),
          task.id,
        )
        .run();
      return json({ ok: true });
    }

    if (action === "comment") {
      const member = await requireMember(db, body.project_id, user);
      if (!member || member.role === "viewer") return json({ error: "Not found" }, 404);
      const text = String(body.body || "").trim();
      if (!text) return json({ error: "body is required" }, 400);
      const id = uid("pcom");
      await db
        .prepare("INSERT INTO project_comments (id, project_id, task_id, user_id, body, created_at) VALUES (?,?,?,?,?,?)")
        .bind(id, body.project_id, body.task_id || null, user.id, text.slice(0, 4000), nowIso())
        .run();
      await notifyProjectMembers(db, body.project_id, user.id, {
        kind: "comment",
        title: `${user.name || user.email} commented`,
        body: text.slice(0, 140),
        href: "/dashboard/projects",
      });
      return json({ id }, 201);
    }

    if (action === "message") {
      const member = await requireMember(db, body.project_id, user);
      if (!member || member.role === "viewer") return json({ error: "Not found" }, 404);
      const text = String(body.body || "").trim();
      if (!text) return json({ error: "body is required" }, 400);
      const id = uid("pmsg");
      await db
        .prepare("INSERT INTO project_messages (id, project_id, user_id, body, created_at) VALUES (?,?,?,?,?)")
        .bind(id, body.project_id, user.id, text.slice(0, 4000), nowIso())
        .run();
      await notifyProjectMembers(db, body.project_id, user.id, {
        kind: "message",
        title: `Project message from ${user.name || user.email}`,
        body: text.slice(0, 140),
        href: "/dashboard/projects",
      });
      return json({ id }, 201);
    }

    return json({ error: "Unknown action" }, 400);
  }

  if (method === "DELETE") {
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      const task = await db.prepare("SELECT * FROM project_tasks WHERE id = ?").bind(taskId).first();
      if (!task) return json({ error: "Task not found" }, 404);
      const member = await requireMember(db, task.project_id, user);
      if (!canManage(member) && task.assigned_user_id !== user.id) return json({ error: "Not found" }, 404);
      await db.prepare("DELETE FROM project_tasks WHERE id = ?").bind(taskId).run();
      return json({ ok: true });
    }
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const project = await db.prepare("SELECT * FROM projects WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first();
    if (!project) return json({ error: "Not found" }, 404);
    await db.prepare("DELETE FROM project_comments WHERE project_id = ?").bind(id).run();
    await db.prepare("DELETE FROM project_messages WHERE project_id = ?").bind(id).run();
    await db.prepare("DELETE FROM project_tasks WHERE project_id = ?").bind(id).run();
    await db.prepare("DELETE FROM project_members WHERE project_id = ?").bind(id).run();
    await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
