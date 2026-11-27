"""MCP API routes — Model Context Protocol server management and tool execution.

Routes follow nerdbot conventions:
- Bearer-token authentication via principal_from_header
- Depends(store.get_conn) for database access
- HTTPException error style
- Routes under /mcp/....
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException

from . import store as store_mod
from . import auth as auth_mod
from .mcp_client import (
    ensure_schema,
    register_server,
    list_servers,
    delete_server,
    call_tool_one_shot,
    MCPConnection,
    success,
    failure,
)


router = APIRouter(prefix="/mcp", tags=["mcp"])


# -- Server CRUD ---

@router.post("/servers", status_code=201)
def create_server(
    name: str,
    transport: str = "stdio",
    command: str | None = None,
    args: dict[str, Any] | None = None,
    url: str | None = None,
    conn: sqlite3.Connection = Depends(store_mod.get_conn),
    principal: str = Depends(auth_mod.principal_from_header),
) -> dict[str, Any]:
    result = register_server(conn, name=name, transport=transport, command=command, args=args, url=url)
    return result


@router.get("/servers")
def list_servers_endpoint(conn: sqlite3.Connection = Depends(store_mod.get_conn), principal: str = Depends(auth_mod.principal_from_header)) -> list[dict[str, Any]]:
    return list_servers(conn)


@router.delete("/servers/{server_id}")
def delete_server_endpoint(
    server_id: str,
    conn: sqlite3.Connection = Depends(store_mod.get_conn),
    principal: str = Depends(auth_mod.principal_from_header),
) -> dict[str, Any]:
    result = delete_server(conn, server_id, principal)
    return result


# -- Tool execution ---

@router.post("/{server_id}/tools/{tool_name}")
def call_tool(
    server_id: str,
    tool_name: str,
    args: dict[str, Any],
    conn: sqlite3.Connection = Depends(store_mod.get_conn),
    principal: str = Depends(auth_mod.principal_from_header),
) -> dict[str, Any]:
    result = call_tool_one_shot(conn, server_id, principal, tool_name, args)
    if isinstance(result, failure):
        raise HTTPException(status_code=400, detail=result["message"])
    return result


@router.get("/{server_id}/status")
def server_status(
    server_id: str,
    conn: sqlite3.Connection = Depends(store_mod.get_conn),
    principal: str = Depends(auth_mod.principal_from_header),
) -> dict[str, Any]:
    row = store_mod.get_conn().execute("SELECT * FROM mcp_servers WHERE id = ?", (server_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {
        "id": row["id"],
        "name": row["name"],
        "transport": row["transport"],
        "status": row["status"],
        "enabled": bool(row["enabled"]),
    }


# -- Tool discovery ---

@router.get("/{server_id}/tools")
def list_server_tools(
    server_id: str,
    conn: sqlite3.Connection = Depends(store_mod.get_conn),
    principal: str = Depends(auth_mod.principal_from_header),
) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM mcp_server_tools WHERE server_id = ? ORDER BY name", (server_id,)).fetchall()
    return [
        {
            "name": row["name"],
            "description": row.get("description") or "",
            "input_schema": json.loads(row["input_schema_json"]) if row.get("input_schema_json") else {},
        }
        for row in rows
    ]