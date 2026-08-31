"""Database layer for the Walking Tour Guide app.

Schema overview
---------------
tours          - one row per published/draft tour (created by any user)
route_points   - dense polyline points that draw the walking path on the map
stops          - narrated waypoints along the route (audio + optional photo)
media_blobs    - binary storage (bytea) for audio/photo files, referenced by id
purchases      - records of a user "buying" a tour (mock checkout for now)
saved_media    - personal photos/audio a user captures while touring
"""

import os

from sqlalchemy import create_engine, text

DB_URL = os.environ.get("DB2007167A_DATABASE_URL")
engine = create_engine(DB_URL, pool_pre_ping=True) if DB_URL else None


def init_db() -> None:
    if engine is None:
        return
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS media_blobs (
                id BIGSERIAL PRIMARY KEY,
                data BYTEA NOT NULL,
                mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tours (
                id BIGSERIAL PRIMARY KEY,
                creator_id TEXT NOT NULL,
                creator_name TEXT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                price_cents INTEGER NOT NULL DEFAULT 0,
                distance_meters DOUBLE PRECISION DEFAULT 0,
                estimated_minutes INTEGER DEFAULT 0,
                start_lat DOUBLE PRECISION,
                start_lng DOUBLE PRECISION,
                end_lat DOUBLE PRECISION,
                end_lng DOUBLE PRECISION,
                cover_photo_id BIGINT REFERENCES media_blobs(id) ON DELETE SET NULL,
                published BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS route_points (
                id BIGSERIAL PRIMARY KEY,
                tour_id BIGINT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                lat DOUBLE PRECISION NOT NULL,
                lng DOUBLE PRECISION NOT NULL
            )
        """))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_route_points_tour ON route_points(tour_id, seq)"
        ))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS stops (
                id BIGSERIAL PRIMARY KEY,
                tour_id BIGINT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                lat DOUBLE PRECISION NOT NULL,
                lng DOUBLE PRECISION NOT NULL,
                title TEXT DEFAULT '',
                audio_media_id BIGINT REFERENCES media_blobs(id) ON DELETE SET NULL,
                photo_media_id BIGINT REFERENCES media_blobs(id) ON DELETE SET NULL,
                trigger_radius_m DOUBLE PRECISION NOT NULL DEFAULT 25
            )
        """))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_stops_tour ON stops(tour_id, seq)"
        ))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS purchases (
                id BIGSERIAL PRIMARY KEY,
                tour_id BIGINT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                price_paid_cents INTEGER NOT NULL DEFAULT 0,
                mock BOOLEAN NOT NULL DEFAULT TRUE,
                purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tour_id, user_id)
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS saved_media (
                id BIGSERIAL PRIMARY KEY,
                tour_id BIGINT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'audio')),
                media_id BIGINT NOT NULL REFERENCES media_blobs(id) ON DELETE CASCADE,
                lat DOUBLE PRECISION,
                lng DOUBLE PRECISION,
                captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tour_progress (
                tour_id BIGINT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                current_seq INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'not_started',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (tour_id, user_id)
            )
        """))
