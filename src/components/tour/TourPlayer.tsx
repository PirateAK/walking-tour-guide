import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { TourDetail, TourStop } from "@/types";
import L from "leaflet";
import { Circle, MapContainer, Marker, Polyline, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Camera,
  Check,
  Clock,
  Footprints,
  Loader2,
  Lock,
  MapPin,
  Mic,
  Navigation,
  Pause,
  Play,
  Square,
  TriangleAlert,
  Volume2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { distanceMeters } from "@/lib/geo";

// Leaflet's default marker icon paths break under Vite bundling — fix once here.
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: icon,
  shadowUrl: iconShadow,
});

const DEFAULT_CENTER: [number, number] = [40.7128, -74.006];

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

type GeoStatus = "acquiring" | "live" | "denied";

function fmtDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function fmtPrice(priceCents: number): string {
  return priceCents === 0 ? "Free" : `$${(priceCents / 100).toFixed(2)}`;
}

/** Numbered pin for each stop — green with a check once visited. */
function stopMarkerIcon(visited: boolean, seq: number): L.DivIcon {
  const bg = visited ? "#16a34a" : "#ffffff";
  const border = visited ? "#15803d" : "#111827";
  const fg = visited ? "#ffffff" : "#111827";
  const label = visited ? "&#10003;" : String(seq);
  return L.divIcon({
    className: "tour-player-marker",
    html: `<div style="width:28px;height:28px;border-radius:9999px;background:${bg};color:${fg};border:2px solid ${border};box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:700 12px/1 system-ui,sans-serif;">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

const userMarkerIcon: L.DivIcon = L.divIcon({
  className: "tour-player-marker",
  html: `<div style="width:18px;height:18px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 8px rgba(37,99,235,.18),0 1px 4px rgba(0,0,0,.4);"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const startMarkerIcon: L.DivIcon = L.divIcon({
  className: "tour-player-marker",
  html: `<div style="font-size:18px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));">&#128681;</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 22],
});

export default function TourPlayer({
  tourId,
  onExit,
}: {
  tourId: number;
  onExit: () => void;
}) {
  // ------------------------------------------------------------- data
  const [detail, setDetail] = useState<TourDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  // --------------------------------------------------------- playback
  const [activeStopId, setActiveStopId] = useState<number | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);

  // -------------------------------------------------- visit tracking
  const [visitedIds, setVisitedIds] = useState<Set<number>>(new Set());

  // ---------------------------------------------- location / session
  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("acquiring");
  const [paused, setPaused] = useState(false);

  // ---------------------------------------------------------- capture
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);

  // -------------------------------------------------- return to start
  const [showReturn, setShowReturn] = useState(false);

  // ------------------------------------------------------------- refs
  const mapRef = useRef<L.Map | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const visitedRef = useRef<Set<number>>(new Set());
  const stopsRef = useRef<TourStop[]>([]);
  const persistedSeqRef = useRef(0);
  const completedRef = useRef(false);
  const firstFixRef = useRef(true);
  const lastCenterRef = useRef<{ lat: number; lng: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const discardRef = useRef(false);

  const loadTour = useCallback(async () => {
    try {
      const res = await fetch(`/api/tours/${tourId}`);
      if (!res.ok) throw new Error();
      const data: TourDetail = await res.json();
      setDetail(data);
      if (data.unlocked) {
        // Resume: stops at or before the saved seq count as already visited,
        // so they don't re-trigger; they're still replayable manually.
        const pRes = await fetch(`/api/tours/${tourId}/progress`);
        if (pRes.ok) {
          const p = (await pRes.json()) as { current_seq: number; status: string };
          persistedSeqRef.current = p.current_seq ?? 0;
          completedRef.current = p.status === "completed";
          if ((p.current_seq ?? 0) > 0) {
            const done = new Set(
              data.stops.filter((s) => s.seq <= (p.current_seq ?? 0)).map((s) => s.id)
            );
            visitedRef.current = done;
            setVisitedIds(done);
          }
        }
      }
    } catch {
      setLoadError("We couldn't load this tour. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [tourId]);

  useEffect(() => {
    void loadTour();
  }, [loadTour]);

  // Keep a ref of stops for callbacks that must not re-create the geo watch.
  useEffect(() => {
    stopsRef.current = detail?.stops ?? [];
  }, [detail]);

  const persistProgress = useCallback(
    async (currentSeq: number, status: "in_progress" | "completed") => {
      try {
        await fetch(`/api/tours/${tourId}/progress`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_seq: currentSeq, status }),
        });
      } catch {
        // Offline blip — the next stop advance will save again.
      }
    },
    [tourId]
  );

  const playStop = useCallback((stop: TourStop) => {
    const audio = audioRef.current;
    if (!audio || stop.audio_media_id === null) return;
    setActiveStopId(stop.id);
    audio.src = `/api/media/${stop.audio_media_id}`;
    audio.play().catch(() => {
      setAudioPlaying(false);
      toast("Tap play to start the narration", {
        description:
          "Your browser blocked autoplay. Press play once — later stops will play automatically.",
      });
    });
  }, []);

  const visitStop = useCallback(
    (stop: TourStop) => {
      if (visitedRef.current.has(stop.id)) return;
      const next = new Set(visitedRef.current);
      next.add(stop.id);
      visitedRef.current = next;
      setVisitedIds(next);

      toast.success(`Stop ${stop.seq} — ${stop.title}`, {
        description: stop.audio_media_id !== null ? "Narration started" : "You've arrived",
      });
      if (stop.audio_media_id !== null) playStop(stop);

      const stops = stopsRef.current;
      const maxSeq = Math.max(persistedSeqRef.current, stop.seq);
      const allVisited = stops.length > 0 && stops.every((s) => next.has(s.id));
      if (allVisited && !completedRef.current) {
        completedRef.current = true;
        persistedSeqRef.current = maxSeq;
        toast.success("Tour complete", { description: "You visited every stop. Well walked!" });
        void persistProgress(maxSeq, "completed");
      } else if (maxSeq > persistedSeqRef.current) {
        persistedSeqRef.current = maxSeq;
        void persistProgress(maxSeq, "in_progress");
      }
    },
    [playStop, persistProgress]
  );

  // Live location watch — proximity triggers narration. Re-created on pause/resume.
  const tracking = !!detail?.unlocked && !paused;

  useEffect(() => {
    if (!tracking || !detail) return;
    if (!("geolocation" in navigator)) {
      setGeoStatus("denied");
      return;
    }
    setGeoStatus("acquiring");

    const handlePosition = (pos: GeolocationPosition) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      setUserPos({ lat, lng });
      setGeoStatus("live");

      // Follow the walker: center on the first fix, then re-center only after
      // they've drifted ~20 m so we don't fight every GPS jitter.
      const map = mapRef.current;
      if (map) {
        const last = lastCenterRef.current;
        if (!last || distanceMeters(last.lat, last.lng, lat, lng) > 20) {
          lastCenterRef.current = { lat, lng };
          map.flyTo([lat, lng], firstFixRef.current ? 17 : map.getZoom(), {
            duration: firstFixRef.current ? 1.5 : 1,
          });
        }
      }
      firstFixRef.current = false;

      for (const stop of detail.stops) {
        if (visitedRef.current.has(stop.id)) continue;
        if (distanceMeters(lat, lng, stop.lat, stop.lng) <= stop.trigger_radius_m) {
          visitStop(stop);
        }
      }
    };

    const handleError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) setGeoStatus("denied");
      // TIMEOUT / POSITION_UNAVAILABLE: the watch keeps trying on its own.
    };

    const id = navigator.geolocation.watchPosition(handlePosition, handleError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000,
    });
    watchIdRef.current = id;

    return () => {
      navigator.geolocation.clearWatch(id);
      if (watchIdRef.current === id) watchIdRef.current = null;
    };
  }, [tracking, detail, visitStop]);

  // Final teardown on unmount (user exits the tour).
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      // Teardown only — the ref still points at the live element here.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      audioRef.current?.pause();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        discardRef.current = true;
        rec.stop();
      }
    };
  }, []);

  const handleStopTap = useCallback(
    (stop: TourStop) => {
      if (stop.audio_media_id === null) {
        toast("This stop has no narration", { description: stop.title });
        return;
      }
      playStop(stop);
    },
    [playStop]
  );

  async function handlePurchase() {
    setPurchasing(true);
    try {
      const res = await fetch(`/api/tours/${tourId}/purchase`, { method: "POST" });
      if (!res.ok) throw new Error();
      toast.success("Tour unlocked", { description: "Enjoy the walk!" });
      await loadTour();
    } catch {
      toast.error("Purchase failed", { description: "Please try again." });
    } finally {
      setPurchasing(false);
    }
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (audio.paused) {
      audio.play().catch(() => {
        toast.error("Playback failed", { description: "Tap play again to retry." });
      });
    } else {
      audio.pause();
    }
  }

  function stopPlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setActiveStopId(null);
  }

  async function uploadCapture(file: Blob, mediaType: "photo" | "audio") {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("media_type", mediaType);
      if (userPos) {
        form.append("lat", String(userPos.lat));
        form.append("lng", String(userPos.lng));
      }
      const ext = mediaType === "photo" ? "jpg" : "webm";
      form.append("file", file, `memory-${Date.now()}.${ext}`);
      const res = await fetch(`/api/tours/${tourId}/saved-media`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error();
      toast.success(
        mediaType === "photo" ? "Photo saved to My Memories" : "Audio note saved to My Memories"
      );
    } catch {
      toast.error("Couldn't save that capture", {
        description: "Check your connection and try again.",
      });
    } finally {
      setUploading(false);
    }
  }

  function handlePhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same shot
    if (!file) return;
    void uploadCapture(file, "photo");
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop(); // onstop uploads the note
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("Audio recording isn't supported on this device.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const discard = discardRef.current;
        discardRef.current = false;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        stopStream();
        setRecording(false);
        if (!discard && blob.size > 0) void uploadCapture(blob, "audio");
      };
      rec.start();
      setRecording(true);
      toast("Recording your personal note", {
        description: "Tap the mic again to stop and save it.",
      });
    } catch {
      stopStream();
      toast.error("Microphone unavailable", { description: "Allow mic access and try again." });
    }
  }

  function handleFinish() {
    completedRef.current = true;
    void persistProgress(persistedSeqRef.current, "completed");
    toast.success("Tour finished", {
      description: "Progress saved — you can revisit this tour anytime.",
    });
  }

  function handleExit() {
    audioRef.current?.pause();
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      discardRef.current = true;
      recorderRef.current.stop();
    }
    onExit();
  }

  // -------------------------------------------------------- derived UI
  const tour = detail?.tour ?? null;
  const stops = detail?.stops ?? [];
  const activeStop =
    activeStopId !== null ? (stops.find((s) => s.id === activeStopId) ?? null) : null;
  const visitedCount = visitedIds.size;
  const totalStops = stops.length;
  const progressPct = totalStops > 0 ? Math.round((visitedCount / totalStops) * 100) : 0;
  const allVisited = totalStops > 0 && stops.every((s) => visitedIds.has(s.id));

  const startPos: [number, number] | null =
    tour?.start_lat != null && tour?.start_lng != null
      ? [tour.start_lat, tour.start_lng]
      : null;

  const returnDistance =
    userPos && startPos ? distanceMeters(userPos.lat, userPos.lng, startPos[0], startPos[1]) : null;

  const initialCenter = useMemo<[number, number]>(() => {
    if (!detail) return DEFAULT_CENTER;
    const firstRoute = detail.route_points[0];
    if (firstRoute) return [firstRoute.lat, firstRoute.lng];
    if (detail.stops.length > 0) return [detail.stops[0].lat, detail.stops[0].lng];
    if (detail.tour.start_lat != null && detail.tour.start_lng != null) {
      return [detail.tour.start_lat, detail.tour.start_lng];
    }
    return DEFAULT_CENTER;
  }, [detail]);

  const routePositions: [number, number][] = detail
    ? detail.route_points.map((p) => [p.lat, p.lng])
    : [];

  const returnLine: [number, number][] | null =
    showReturn && userPos && startPos ? [startPos, [userPos.lat, userPos.lng]] : null;

  // ------------------------------------------------------------ render
  if (loading) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading tour&hellip;</p>
      </div>
    );
  }

  if (loadError || !detail || !tour) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <TriangleAlert className="h-8 w-8 text-destructive" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{loadError ?? "Tour not found."}</p>
        <Button variant="outline" onClick={onExit}>
          Back to tours
        </Button>
      </div>
    );
  }

  const locked = !detail.unlocked && tour.price_cents > 0 && !detail.is_owner;

  const renderMap = (interactive: boolean) => (
    <MapContainer
      ref={mapRef}
      center={initialCenter}
      zoom={interactive ? 16 : 15}
      zoomControl={false}
      scrollWheelZoom={interactive}
      className="h-full w-full"
    >
      <TileLayer
        attribution={OSM_ATTRIBUTION}
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {routePositions.length > 1 && (
        <Polyline
          positions={routePositions}
          pathOptions={{ color: "#111827", weight: 4, opacity: 0.7 }}
        />
      )}
      {startPos && <Marker position={startPos} icon={startMarkerIcon} />}
      {stops.map((stop) => (
        <Fragment key={stop.id}>
          <Circle
            center={[stop.lat, stop.lng]}
            radius={stop.trigger_radius_m}
            pathOptions={{
              color: "#16a34a",
              weight: 1,
              opacity: 0.35,
              fillColor: "#16a34a",
              fillOpacity: 0.06,
            }}
          />
          <Marker
            position={[stop.lat, stop.lng]}
            icon={stopMarkerIcon(visitedIds.has(stop.id), stop.seq)}
            eventHandlers={interactive ? { click: () => handleStopTap(stop) } : undefined}
          />
        </Fragment>
      ))}
      {interactive && userPos && (
        <Marker position={[userPos.lat, userPos.lng]} icon={userMarkerIcon} zIndexOffset={1000} />
      )}
      {interactive && returnLine && (
        <Polyline
          positions={returnLine}
          pathOptions={{ color: "#dc2626", weight: 3, dashArray: "6 8", opacity: 0.9 }}
        />
      )}
    </MapContainer>
  );

  if (locked) {
    return (
      <div className="flex h-dvh flex-col bg-background">
        <header className="flex items-center gap-2 border-b border-border px-2 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            aria-label="Exit tour"
            onClick={onExit}
          >
            <X className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{tour.title}</p>
            <p className="truncate text-xs text-muted-foreground">Preview</p>
          </div>
        </header>

        <div className="relative min-h-0 flex-1">{renderMap(false)}</div>

        <div className="z-10 rounded-t-2xl border-t border-border bg-card px-4 pb-6 pt-4 shadow-[0_-8px_24px_rgba(0,0,0,0.08)]">
          <div className="mx-auto max-w-lg space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Footprints className="h-4 w-4" aria-hidden="true" />
                {fmtDistance(tour.distance_meters)}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" aria-hidden="true" />
                {tour.estimated_minutes} min
              </span>
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" aria-hidden="true" />
                {stops.length} stops
              </span>
            </div>
            {tour.creator_name && (
              <p className="text-xs text-muted-foreground">Created by {tour.creator_name}</p>
            )}
            {tour.description && (
              <p className="line-clamp-3 text-sm text-muted-foreground">{tour.description}</p>
            )}
            <Button
              className="h-12 w-full gap-2 text-base"
              disabled={purchasing}
              onClick={() => void handlePurchase()}
            >
              {purchasing ? (
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              ) : (
                <Lock className="h-5 w-5" aria-hidden="true" />
              )}
              {purchasing
                ? "Unlocking\u2026"
                : `Buy for ${fmtPrice(tour.price_cents)} \u2014 mock checkout`}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Preview shows the route and stops. Audio narration and photos unlock after purchase.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------- full player
  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="z-20 flex items-center gap-2 border-b border-border bg-background px-2 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0"
          aria-label="Exit tour"
          onClick={handleExit}
        >
          <X className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{tour.title}</p>
          <p className="text-xs text-muted-foreground">
            {fmtDistance(tour.distance_meters)} &middot; {tour.estimated_minutes} min
          </p>
        </div>
        <span
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
            paused
              ? "border-border bg-muted text-muted-foreground"
              : geoStatus === "live"
                ? "border-green-600/30 bg-green-50 text-green-700"
                : geoStatus === "acquiring"
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-amber-600/30 bg-amber-50 text-amber-700"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-2 w-2 rounded-full",
              paused
                ? "bg-zinc-400"
                : geoStatus === "live"
                  ? "bg-green-500"
                  : geoStatus === "acquiring"
                    ? "animate-pulse bg-amber-500"
                    : "bg-amber-500"
            )}
          />
          {paused
            ? "Paused"
            : geoStatus === "live"
              ? "GPS"
              : geoStatus === "acquiring"
                ? "Locating\u2026"
                : "No GPS"}
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        {renderMap(true)}

        {userPos && showReturn && returnDistance !== null && (
          <div
            className={cn(
              "absolute inset-x-0 z-[1000] flex justify-center",
              !paused && geoStatus === "denied" ? "top-14" : "top-3"
            )}
          >
            <span className="rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
              {fmtDistance(returnDistance)} to start (straight line)
            </span>
          </div>
        )}

        {!paused && geoStatus === "denied" && (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-[1000] flex items-start gap-2 rounded-xl border border-amber-600/30 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow-md backdrop-blur">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Location is off, so narration won&apos;t auto-trigger. Allow location access, or tap
              any stop on the map or in the list below to play it.
            </span>
          </div>
        )}

        {/* Capture personal media — photos and audio notes for the tourist */}
        <div
          className={cn(
            "absolute right-3 z-[1000] flex flex-col gap-2 transition-[bottom]",
            activeStop ? "bottom-[6.5rem]" : "bottom-3"
          )}
        >
          <button
            type="button"
            aria-label="Take a photo"
            disabled={uploading}
            onClick={() => photoInputRef.current?.click()}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-background/95 text-foreground shadow-lg backdrop-blur transition-transform active:scale-95 disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <Camera className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            aria-label={recording ? "Stop recording audio note" : "Record an audio note"}
            disabled={uploading && !recording}
            onClick={() => void toggleRecording()}
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-full border shadow-lg transition-transform active:scale-95 disabled:opacity-50",
              recording
                ? "animate-pulse border-red-600 bg-red-600 text-white"
                : "border-border bg-background/95 text-foreground backdrop-blur"
            )}
          >
            {recording ? (
              <Square className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Mic className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* High-contrast now-playing overlay */}
        {activeStop && (
          <div className="absolute inset-x-3 bottom-3 z-[1000]">
            <div className="flex items-center gap-3 rounded-2xl bg-zinc-900/95 p-3 text-white shadow-2xl ring-1 ring-white/10 backdrop-blur">
              {activeStop.photo_media_id !== null ? (
                <img
                  src={`/api/media/${activeStop.photo_media_id}`}
                  alt={activeStop.title}
                  className="h-14 w-14 shrink-0 rounded-xl object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/10"
                >
                  <Volume2 className="h-6 w-6 text-white/80" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wider text-white/60">
                  Now playing &middot; Stop {activeStop.seq}
                </p>
                <p className="truncate text-sm font-semibold">{activeStop.title}</p>
              </div>
              <button
                type="button"
                onClick={togglePlayPause}
                aria-label={audioPlaying ? "Pause narration" : "Play narration"}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900 transition-transform active:scale-95"
              >
                {audioPlaying ? (
                  <Pause className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Play className="h-5 w-5" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={stopPlayback}
                aria-label="Stop narration"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Square className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom control panel */}
      <div className="z-20 border-t border-border bg-background/95 backdrop-blur">
        <div className="flex items-center gap-3 px-4 pt-3">
          <Progress value={progressPct} className="h-2 flex-1" aria-label="Tour progress" />
          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
            {visitedCount}/{totalStops} stops
          </span>
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-11 flex-1 gap-1.5 text-sm"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? (
              <Play className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Pause className="h-4 w-4" aria-hidden="true" />
            )}
            {paused ? "Resume tour" : "Pause tour"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-11 flex-1 gap-1.5 text-sm",
              showReturn && "border-red-600/40 bg-red-50 text-red-700 hover:bg-red-100"
            )}
            disabled={!startPos || !userPos}
            title={!userPos ? "Waiting for your location\u2026" : undefined}
            onClick={() => setShowReturn((s) => !s)}
          >
            <Navigation className="h-4 w-4" aria-hidden="true" />
            Return
          </Button>
          <Button
            size="sm"
            variant={allVisited ? "default" : "outline"}
            className="h-11 shrink-0 gap-1.5 text-sm"
            onClick={handleFinish}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            Finish
          </Button>
        </div>

        <div className="border-t border-border">
          <p className="px-4 pt-2 text-xs font-medium text-muted-foreground">
            Tap any stop to preview its narration — no walking required
          </p>
          <div className="max-h-48 overflow-y-auto" aria-label="Tour stops">
          {totalStops === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">This tour has no stops yet.</p>
          )}
          {stops.map((stop) => {
            const visited = visitedIds.has(stop.id);
            return (
              <button
                key={stop.id}
                type="button"
                onClick={() => handleStopTap(stop)}
                className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/60 active:bg-accent"
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    visited ? "bg-green-600 text-white" : "bg-muted text-foreground"
                  )}
                >
                  {visited ? <Check className="h-4 w-4" aria-hidden="true" /> : stop.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{stop.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {visited
                      ? "Visited — tap to replay"
                      : `Triggers within ${stop.trigger_radius_m} m while walking`}
                    {stop.audio_media_id === null && " · no narration"}
                  </span>
                </span>
                {stop.audio_media_id !== null && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    Play
                  </span>
                )}
              </button>
            );
          })}
          </div>
        </div>
      </div>

      {/* Hidden input for camera capture */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handlePhotoChange}
        aria-hidden="true"
        tabIndex={-1}
      />
      <audio
        ref={audioRef}
        className="hidden"
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onEnded={() => setActiveStopId(null)}
        onError={() => {
          setActiveStopId(null);
          setAudioPlaying(false);
          toast.error("Couldn't play that narration");
        }}
      />
    </div>
  );
}
