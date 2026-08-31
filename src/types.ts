export type ApiStatus = "checking" | "connected" | "error";

export interface HealthResponse {
  ok: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface TourSummary {
  id: number;
  creator_name: string | null;
  title: string;
  description: string;
  price_cents: number;
  distance_meters: number;
  estimated_minutes: number;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  cover_photo_id: number | null;
  created_at: string;
  published?: boolean;
}

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface TourStop {
  id: number;
  seq: number;
  lat: number;
  lng: number;
  title: string;
  audio_media_id: number | null;
  photo_media_id: number | null;
  trigger_radius_m: number;
}

export interface TourDetail {
  tour: TourSummary & { creator_id: string };
  is_owner: boolean;
  unlocked: boolean;
  route_points: RoutePoint[];
  stops: TourStop[];
}

export interface SavedMediaItem {
  id: number;
  tour_id?: number;
  tour_title?: string;
  media_type: "photo" | "audio";
  media_id: number;
  lat: number | null;
  lng: number | null;
  captured_at: string;
}
