# Route Inventory (dashboard hash routes)

Home (#/) command composer + active work + approvals.
Work (#/work) unified tasks buckets.
Agents (#/bots, #/bot/:id).
Approvals (#/approvals).
Settings (#/settings) providers/integrations/permissions.
Contextual: Projects (#/projects, #/project/:id/* 15 tabs), Boards (#/boards), Teams (#/teams), Tasks (#/task/:id), Chat threads (#/chat/:id).

Backend: FastAPI 8080, SQLite WAL, isolated git workspaces. All routes authed via bearer token.
