"""Workstation API routes — per-agent isolated Docker environments.

Routes follow nerdbot conventions:
- Bearer-token authentication via ``principal_from_header``
- ``Depends(store.get_conn)`` for database access
- ``HTTPException`` for errors
- Routes under ``/workstations/...."""