import asyncio
import os

import httpx
from fastapi import (
    APIRouter,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from auth import get_current_user, require_auth
from db import engine, init_db

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB cap (audio clips / photos)

INLINE_SAFE_MIME = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4",
}


def _save_blob(contents: bytes, mime: str) -> int:
    with engine.begin() as conn:
        return conn.execute(text(
            "INSERT INTO media_blobs (data, mime_type) VALUES (:d, :m) RETURNING id"
        ), {"d": contents, "m": mime}).scalar()


async def _read_upload(file: UploadFile | None) -> tuple[bytes | None, str | None]:
    if file is None:
        return None, None
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if not contents:
        return None, None
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 15 MB)")
    return contents, (file.content_type or "application/octet-stream")


def create_app(static_dir: str) -> FastAPI:
    init_db()

    api = APIRouter()

    @api.get("/health")
    def health():
        return {"ok": True}

    # ---------------------------------------------------------------- auth
    @api.api_route("/neon-auth/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"])
    async def neon_auth_proxy(request: Request, path: str):
        neon_auth_url = os.environ.get("DB2007167A_NEON_AUTH_URL", "").rstrip("/")
        fwd_headers = {k: v for k, v in request.headers.items()
                       if k.lower() not in ("host", "content-length", "transfer-encoding", "connection")}
        async with httpx.AsyncClient() as client:
            resp = await client.request(
                method=request.method, url=f"{neon_auth_url}/{path}",
                headers=fwd_headers, content=await request.body(),
                params=dict(request.query_params), follow_redirects=False, timeout=10,
            )
        resp_headers = {k: v for k, v in resp.headers.multi_items()
                        if k.lower() not in ("transfer-encoding", "content-encoding", "content-length", "connection")}
        return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)

    @api.get("/me")
    def me(request: Request):
        user = get_current_user(request, engine)
        return {"user": user}

    # --------------------------------------------------------------- media
    @api.get("/media/{media_id}")
    def get_media(media_id: int):
        with engine.connect() as conn:
            row = conn.execute(text(
                "SELECT data, mime_type FROM media_blobs WHERE id = :i"
            ), {"i": media_id}).fetchone()
        if not row or row.data is None:
            raise HTTPException(404)
        stored_mime = (row.mime_type or "").lower()
        if stored_mime in INLINE_SAFE_MIME:
            media_type, disposition = stored_mime, "inline"
        else:
            media_type, disposition = "application/octet-stream", "attachment"
        return Response(
            content=bytes(row.data),
            media_type=media_type,
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": disposition,
            },
        )

    # --------------------------------------------------------------- tours
    @api.get("/tours")
    def list_tours():
        """Published tours for the marketplace map/browse."""
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, creator_name, title, description, price_cents,
                       distance_meters, estimated_minutes,
                       start_lat, start_lng, end_lat, end_lng,
                       cover_photo_id, created_at
                FROM tours WHERE published = TRUE ORDER BY created_at DESC
            """)).fetchall()
        return [dict(r._mapping) for r in rows]

    @api.get("/tours/mine")
    def my_tours(request: Request):
        user = require_auth(request, engine)
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, title, description, price_cents, distance_meters,
                       estimated_minutes, published, cover_photo_id, created_at
                FROM tours WHERE creator_id = :u ORDER BY created_at DESC
            """), {"u": user["id"]}).fetchall()
        return [dict(r._mapping) for r in rows]

    @api.get("/tours/purchased")
    def purchased_tours(request: Request):
        user = require_auth(request, engine)
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT t.id, t.title, t.description, t.distance_meters,
                       t.estimated_minutes, t.start_lat, t.start_lng,
                       t.cover_photo_id, p.purchased_at
                FROM purchases p JOIN tours t ON t.id = p.tour_id
                WHERE p.user_id = :u ORDER BY p.purchased_at DESC
            """), {"u": user["id"]}).fetchall()
        return [dict(r._mapping) for r in rows]

    @api.get("/tours/{tour_id}")
    def get_tour(tour_id: int, request: Request):
        user = get_current_user(request, engine)
        with engine.connect() as conn:
            tour = conn.execute(text("""
                SELECT id, creator_id, creator_name, title, description, price_cents,
                       distance_meters, estimated_minutes, start_lat, start_lng,
                       end_lat, end_lng, cover_photo_id, published, created_at
                FROM tours WHERE id = :i
            """), {"i": tour_id}).fetchone()
            if not tour:
                raise HTTPException(404)
            is_owner = user and user["id"] == tour.creator_id
            owns_purchase = False
            if user:
                p = conn.execute(text(
                    "SELECT 1 FROM purchases WHERE tour_id = :t AND user_id = :u"
                ), {"t": tour_id, "u": user["id"]}).fetchone()
                owns_purchase = bool(p)

            route_points = conn.execute(text(
                "SELECT lat, lng FROM route_points WHERE tour_id = :i ORDER BY seq"
            ), {"i": tour_id}).fetchall()

            unlocked = is_owner or owns_purchase or tour.price_cents == 0
            if unlocked:
                stops = conn.execute(text("""
                    SELECT id, seq, lat, lng, title, audio_media_id, photo_media_id, trigger_radius_m
                    FROM stops WHERE tour_id = :i ORDER BY seq
                """), {"i": tour_id}).fetchall()
            else:
                # Preview only: locations without media
                stops = conn.execute(text("""
                    SELECT id, seq, lat, lng, title, NULL::bigint AS audio_media_id,
                           NULL::bigint AS photo_media_id, trigger_radius_m
                    FROM stops WHERE tour_id = :i ORDER BY seq
                """), {"i": tour_id}).fetchall()

        return {
            "tour": dict(tour._mapping),
            "is_owner": bool(is_owner),
            "unlocked": unlocked,
            "route_points": [dict(r._mapping) for r in route_points],
            "stops": [dict(r._mapping) for r in stops],
        }

    @api.post("/tours")
    def create_tour(request: Request, payload: dict):
        user = require_auth(request, engine)
        title = (payload.get("title") or "Untitled Tour").strip()
        with engine.begin() as conn:
            tour_id = conn.execute(text("""
                INSERT INTO tours (creator_id, creator_name, title)
                VALUES (:cid, :cname, :title) RETURNING id
            """), {"cid": user["id"], "cname": user.get("name") or user.get("email"), "title": title}).scalar()
        return {"id": tour_id}

    @api.patch("/tours/{tour_id}")
    def update_tour(tour_id: int, request: Request, payload: dict):
        user = require_auth(request, engine)
        with engine.begin() as conn:
            owner = conn.execute(text("SELECT creator_id FROM tours WHERE id = :i"), {"i": tour_id}).fetchone()
            if not owner or owner.creator_id != user["id"]:
                raise HTTPException(403)
            fields, params = [], {"i": tour_id}
            for key in ("title", "description", "published"):
                if key in payload:
                    fields.append(f"{key} = :{key}")
                    params[key] = payload[key]
            if "price_dollars" in payload:
                fields.append("price_cents = :price_cents")
                params["price_cents"] = round(float(payload["price_dollars"]) * 100)
            if fields:
                conn.execute(text(f"UPDATE tours SET {', '.join(fields)} WHERE id = :i"), params)
        return {"ok": True}

    @api.post("/tours/{tour_id}/route")
    def save_route(tour_id: int, request: Request, payload: dict):
        """payload: {points: [{lat, lng}], distance_meters, estimated_minutes}"""
        user = require_auth(request, engine)
        points = payload.get("points", [])
        with engine.begin() as conn:
            owner = conn.execute(text("SELECT creator_id FROM tours WHERE id = :i"), {"i": tour_id}).fetchone()
            if not owner or owner.creator_id != user["id"]:
                raise HTTPException(403)
            conn.execute(text("DELETE FROM route_points WHERE tour_id = :i"), {"i": tour_id})
            for seq, pt in enumerate(points):
                conn.execute(text(
                    "INSERT INTO route_points (tour_id, seq, lat, lng) VALUES (:t, :s, :lat, :lng)"
                ), {"t": tour_id, "s": seq, "lat": pt["lat"], "lng": pt["lng"]})
            start = points[0] if points else None
            end = points[-1] if points else None
            conn.execute(text("""
                UPDATE tours SET distance_meters = :dist, estimated_minutes = :mins,
                       start_lat = :sla, start_lng = :sln, end_lat = :ela, end_lng = :eln
                WHERE id = :i
            """), {
                "dist": payload.get("distance_meters", 0),
                "mins": payload.get("estimated_minutes", 0),
                "sla": start["lat"] if start else None, "sln": start["lng"] if start else None,
                "ela": end["lat"] if end else None, "eln": end["lng"] if end else None,
                "i": tour_id,
            })
        return {"ok": True}

    @api.post("/tours/{tour_id}/cover")
    async def upload_cover(tour_id: int, request: Request, file: UploadFile = File(...)):
        user = require_auth(request, engine)
        contents, mime = await _read_upload(file)
        if not contents:
            raise HTTPException(400, "Empty file")
        with engine.begin() as conn:
            owner = conn.execute(text("SELECT creator_id FROM tours WHERE id = :i"), {"i": tour_id}).fetchone()
            if not owner or owner.creator_id != user["id"]:
                raise HTTPException(403)
        media_id = await asyncio.to_thread(_save_blob, contents, mime)
        with engine.begin() as conn:
            conn.execute(text("UPDATE tours SET cover_photo_id = :m WHERE id = :i"), {"m": media_id, "i": tour_id})
        return {"media_id": media_id}

    # --------------------------------------------------------------- stops
    @api.post("/tours/{tour_id}/stops")
    async def create_stop(
        tour_id: int,
        request: Request,
        seq: int = Form(...),
        lat: float = Form(...),
        lng: float = Form(...),
        title: str = Form(""),
        trigger_radius_m: float = Form(25),
        audio: UploadFile | None = File(None),
        photo: UploadFile | None = File(None),
    ):
        user = require_auth(request, engine)
        with engine.begin() as conn:
            owner = conn.execute(text("SELECT creator_id FROM tours WHERE id = :i"), {"i": tour_id}).fetchone()
            if not owner or owner.creator_id != user["id"]:
                raise HTTPException(403)

        audio_bytes, audio_mime = await _read_upload(audio)
        photo_bytes, photo_mime = await _read_upload(photo)
        audio_id = await asyncio.to_thread(_save_blob, audio_bytes, audio_mime) if audio_bytes else None
        photo_id = await asyncio.to_thread(_save_blob, photo_bytes, photo_mime) if photo_bytes else None

        with engine.begin() as conn:
            stop_id = conn.execute(text("""
                INSERT INTO stops (tour_id, seq, lat, lng, title, audio_media_id, photo_media_id, trigger_radius_m)
                VALUES (:t, :s, :lat, :lng, :title, :a, :p, :r) RETURNING id
            """), {
                "t": tour_id, "s": seq, "lat": lat, "lng": lng, "title": title,
                "a": audio_id, "p": photo_id, "r": trigger_radius_m,
            }).scalar()
        return {"id": stop_id, "audio_media_id": audio_id, "photo_media_id": photo_id}

    @api.delete("/stops/{stop_id}")
    def delete_stop(stop_id: int, request: Request):
        user = require_auth(request, engine)
        with engine.begin() as conn:
            row = conn.execute(text("""
                SELECT s.id, t.creator_id FROM stops s JOIN tours t ON t.id = s.tour_id WHERE s.id = :i
            """), {"i": stop_id}).fetchone()
            if not row or row.creator_id != user["id"]:
                raise HTTPException(403)
            conn.execute(text("DELETE FROM stops WHERE id = :i"), {"i": stop_id})
        return {"ok": True}

    # ----------------------------------------------------------- purchase
    @api.post("/tours/{tour_id}/purchase")
    def purchase_tour(tour_id: int, request: Request):
        """Mock checkout — records a purchase with no real payment processing."""
        user = require_auth(request, engine)
        with engine.begin() as conn:
            tour = conn.execute(text("SELECT price_cents FROM tours WHERE id = :i AND published = TRUE"), {"i": tour_id}).fetchone()
            if not tour:
                raise HTTPException(404)
            conn.execute(text("""
                INSERT INTO purchases (tour_id, user_id, price_paid_cents, mock)
                VALUES (:t, :u, :p, TRUE)
                ON CONFLICT (tour_id, user_id) DO NOTHING
            """), {"t": tour_id, "u": user["id"], "p": tour.price_cents})
        return {"ok": True}

    # ------------------------------------------------------ saved media
    @api.post("/tours/{tour_id}/saved-media")
    async def save_media(
        tour_id: int,
        request: Request,
        media_type: str = Form(...),
        lat: float | None = Form(None),
        lng: float | None = Form(None),
        file: UploadFile = File(...),
    ):
        user = require_auth(request, engine)
        contents, mime = await _read_upload(file)
        if not contents:
            raise HTTPException(400, "Empty file")
        blob_id = await asyncio.to_thread(_save_blob, contents, mime)
        with engine.begin() as conn:
            row_id = conn.execute(text("""
                INSERT INTO saved_media (tour_id, user_id, media_type, media_id, lat, lng)
                VALUES (:t, :u, :mt, :m, :lat, :lng) RETURNING id
            """), {"t": tour_id, "u": user["id"], "mt": media_type, "m": blob_id, "lat": lat, "lng": lng}).scalar()
        return {"id": row_id, "media_id": blob_id}

    @api.get("/tours/{tour_id}/saved-media")
    def list_saved_media(tour_id: int, request: Request):
        user = require_auth(request, engine)
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, media_type, media_id, lat, lng, captured_at
                FROM saved_media WHERE tour_id = :t AND user_id = :u ORDER BY captured_at
            """), {"t": tour_id, "u": user["id"]}).fetchall()
        return [dict(r._mapping) for r in rows]

    @api.get("/saved-media")
    def list_all_saved_media(request: Request):
        """All personal captures across every tour, for a 'my memories' view."""
        user = require_auth(request, engine)
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT sm.id, sm.tour_id, t.title AS tour_title, sm.media_type,
                       sm.media_id, sm.lat, sm.lng, sm.captured_at
                FROM saved_media sm JOIN tours t ON t.id = sm.tour_id
                WHERE sm.user_id = :u ORDER BY sm.captured_at DESC
            """), {"u": user["id"]}).fetchall()
        return [dict(r._mapping) for r in rows]

    # -------------------------------------------------------------- progress
    @api.get("/tours/{tour_id}/progress")
    def get_progress(tour_id: int, request: Request):
        user = require_auth(request, engine)
        with engine.connect() as conn:
            row = conn.execute(text("""
                SELECT current_seq, status FROM tour_progress WHERE tour_id = :t AND user_id = :u
            """), {"t": tour_id, "u": user["id"]}).fetchone()
        return dict(row._mapping) if row else {"current_seq": 0, "status": "not_started"}

    @api.put("/tours/{tour_id}/progress")
    def set_progress(tour_id: int, request: Request, payload: dict):
        user = require_auth(request, engine)
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO tour_progress (tour_id, user_id, current_seq, status, updated_at)
                VALUES (:t, :u, :seq, :status, NOW())
                ON CONFLICT (tour_id, user_id) DO UPDATE
                SET current_seq = :seq, status = :status, updated_at = NOW()
            """), {"t": tour_id, "u": user["id"], "seq": payload.get("current_seq", 0), "status": payload.get("status", "in_progress")})
        return {"ok": True}

    app = FastAPI()
    app.include_router(api, prefix="/api")

    if os.path.isdir(static_dir):
        assets_dir = os.path.join(static_dir, "assets")
        if os.path.isdir(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def spa_fallback(request: Request, path: str):
            file_path = os.path.join(static_dir, path)
            if path and os.path.isfile(file_path):
                return FileResponse(file_path)
            return FileResponse(
                os.path.join(static_dir, "index.html"),
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )

    return app
