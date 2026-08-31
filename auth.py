"""Neon Auth session validation helper."""

from fastapi import HTTPException, Request
from sqlalchemy import text

COOKIE_NAME = "__Secure-neon-auth.session_token"


def get_current_user(request: Request, engine) -> dict | None:
    """Return the current user dict, or None if not authenticated."""
    if engine is None:
        return None
    cookie_val = request.cookies.get(COOKIE_NAME, "")
    if not cookie_val:
        return None
    token = cookie_val.split(".")[0]
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT u.id, u.email, u.name
            FROM neon_auth.session s
            JOIN neon_auth.user u ON s."userId" = u.id
            WHERE s.token = :token AND s."expiresAt" > NOW()
        """), {"token": token}).fetchone()
    if not row:
        return None
    return {"id": str(row.id), "email": row.email, "name": row.name}


def require_auth(request: Request, engine) -> dict:
    user = get_current_user(request, engine)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user
