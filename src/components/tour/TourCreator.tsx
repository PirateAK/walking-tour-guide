import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import { toast } from "sonner";
import type { TourDetail, TourStop } from "@/types";
import { distanceMeters, estimateWalkingMinutes, routeDistanceMeters } from "@/lib/geo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  AudioLines,
  Camera,
  CircleAlert,
  Footprints,
  ImagePlus,
  Loader2,
  MapPin,
  Mic,
  Pause,
  Play,
  Save,
  Square,
  Trash2,
} from "lucide-react";

// Leaflet default marker icons are broken under bundlers — fix once at module load.
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: icon,
  shadowUrl: iconShadow,
});

type RecState = "idle" | "recording" | "paused";
type LatLng = { lat: number; lng: number };

const DEFAULT_CENTER: [number, number] = [37.7749, -122.4194];

const userIcon = L.divIcon({
  className: "user-marker",
  html: '<span class="user-marker-dot"></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function geoErrorMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED)
    return "Location permission denied. Enable it in your browser settings to record your route.";
  if (err.code === err.POSITION_UNAVAILABLE)
    return "Location unavailable right now — try moving to a spot with a clearer view of the sky.";
  return "Getting your location timed out. Tap the button again to retry.";
}

/* ---------- Map helpers (children of MapContainer) ---------- */

function FollowUser({ pos, follow }: { pos: LatLng | null; follow: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (follow && pos) {
      map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 17), { animate: true });
    }
  }, [pos, follow, map]);
  return null;
}

function FitAll({ points, trigger }: { points: LatLng[]; trigger: number }) {
  const map = useMap();
  useEffect(() => {
    if (points.length >= 2) {
      map.fitBounds(
        L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])),
        { padding: [32, 32], maxZoom: 17 }
      );
    } else if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 17);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, map]);
  return null;
}

/* ---------- Main component ---------- */

export default function TourCreator({
  tourId,
  onDone,
}: {
  tourId?: number;
  onDone: () => void;
}) {
  // Tour identity + meta
  const [activeTourId, setActiveTourId] = useState<number | null>(tourId ?? null);
  const [booting, setBooting] = useState(!tourId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled Tour");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("0");
  const [coverPhotoId, setCoverPhotoId] = useState<number | null>(null);
  const [published, setPublished] = useState(false);
  const [detailsStatus, setDetailsStatus] = useState<"idle" | "saving" | "saved">("idle");

  // Content
  const [stops, setStops] = useState<TourStop[]>([]);
  const [routePoints, setRoutePoints] = useState<LatLng[]>([]);
  const [savedMeters, setSavedMeters] = useState(0);
  const [savedMinutes, setSavedMinutes] = useState(0);

  // Route recording
  const [recState, setRecState] = useState<RecState>("idle");
  const [livePos, setLivePos] = useState<LatLng | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [fitTrigger, setFitTrigger] = useState(0);

  // Add-stop dialog
  const [stopOpen, setStopOpen] = useState(false);
  const [capturingFix, setCapturingFix] = useState(false);
  const [stopPos, setStopPos] = useState<LatLng | null>(null);
  const [stopTitle, setStopTitle] = useState("");
  const [radius, setRadius] = useState("25");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioRecording, setAudioRecording] = useState(false);
  const [audioSecs, setAudioSecs] = useState(0);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [savingStop, setSavingStop] = useState(false);

  // Refs
  const bootedRef = useRef(false);
  const watchIdRef = useRef<number | null>(null);
  const routePointsRef = useRef<LatLng[]>([]);
  const lastPointRef = useRef<LatLng | null>(null);
  const lastAppendAtRef = useRef(0);
  const gotFirstFixRef = useRef(false);
  const lastSavedDetailsRef = useRef("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const trackObjectUrl = (url: string) => objectUrlsRef.current.push(url);

  /* ---------- Boot: load existing tour or create a draft ---------- */

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    if (typeof tourId === "number") {
      (async () => {
        try {
          const res = await fetch(`/api/tours/${tourId}`);
          if (!res.ok) throw new Error("fetch failed");
          const detail: TourDetail = await res.json();
          if (!detail.is_owner) {
            setLoadError("You can only edit tours you created.");
            return;
          }
          setTitle(detail.tour.title || "Untitled Tour");
          setDescription(detail.tour.description ?? "");
          setPrice((detail.tour.price_cents / 100).toFixed(2));
          setCoverPhotoId(detail.tour.cover_photo_id);
          setPublished(detail.tour.published ?? false);
          setSavedMeters(detail.tour.distance_meters);
          setSavedMinutes(detail.tour.estimated_minutes);
          setStops([...detail.stops].sort((a, b) => a.seq - b.seq));
          routePointsRef.current = detail.route_points;
          setRoutePoints(detail.route_points);
          setFitTrigger((t) => t + 1);
          setLoadError(null);
        } catch {
          setLoadError("Couldn't load this tour. Check your connection and try again.");
        } finally {
          setBooting(false);
        }
      })();
    } else {
      // New tour: create the draft first so every later call has an id to hit.
      (async () => {
        try {
          const res = await fetch("/api/tours", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Untitled Tour" }),
          });
          if (!res.ok) throw new Error("create failed");
          const data: { id: number } = await res.json();
          setActiveTourId(data.id);
        } catch {
          setLoadError("Couldn't create a new tour. Check your connection and try again.");
        } finally {
          setBooting(false);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Unmount cleanup ---------- */

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      if (audioTimerRef.current) clearInterval(audioTimerRef.current);
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  /* ---------- Tour details (save on blur, round-trips) ---------- */

  const saveDetails = () => {
    if (!activeTourId) return;
    const payload = {
      title: title.trim() || "Untitled Tour",
      description,
      price_dollars: Math.max(0, Number.isFinite(parseFloat(price)) ? parseFloat(price) : 0),
    };
    const key = JSON.stringify(payload);
    if (key === lastSavedDetailsRef.current) return;
    lastSavedDetailsRef.current = key;
    setDetailsStatus("saving");
    fetch(`/api/tours/${activeTourId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => {
        if (!r.ok) throw new Error("save failed");
        setDetailsStatus("saved");
      })
      .catch(() => {
        setDetailsStatus("idle");
        toast.error("Couldn't save tour details");
      });
  };

  /* ---------- Route recording ---------- */

  function appendPoint(p: LatLng) {
    lastPointRef.current = p;
    lastAppendAtRef.current = Date.now();
    routePointsRef.current = [...routePointsRef.current, p];
    setRoutePoints(routePointsRef.current);
  }

  function startWatch() {
    if (!("geolocation" in navigator)) {
      setGeoError("Your browser doesn't support GPS location, so route recording isn't available.");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoError(null);
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setLivePos(p);
        if (!gotFirstFixRef.current) {
          gotFirstFixRef.current = true;
          setFitTrigger((t) => t + 1);
        }
        const last = lastPointRef.current;
        if (!last) {
          appendPoint(p);
          return;
        }
        const moved = distanceMeters(last.lat, last.lng, p.lat, p.lng);
        const sinceAppend = Date.now() - lastAppendAtRef.current;
        // Throttle: append on real movement, or a slow trickle for long pauses.
        if (moved >= 5 || (moved >= 1 && sinceAppend >= 4000)) appendPoint(p);
      },
      (err) => setGeoError(geoErrorMessage(err)),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    watchIdRef.current = id;
    setRecState("recording");
  }

  function pauseRecording() {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setRecState("paused");
  }

  function resumeRecording() {
    startWatch();
    setGeoError(null);
  }

  function stopWatch() {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }

  async function finishRecording() {
    stopWatch();
    setRecState("idle");
    const pts = routePointsRef.current;
    if (!activeTourId) return;
    if (pts.length < 2) {
      toast.error("Not enough GPS points recorded yet — walk a bit further, then finish.");
      return;
    }
    const meters = routeDistanceMeters(pts);
    const minutes = estimateWalkingMinutes(meters);
    try {
      const res = await fetch(`/api/tours/${activeTourId}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: pts,
          distance_meters: Math.round(meters),
          estimated_minutes: minutes,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setSavedMeters(Math.round(meters));
      setSavedMinutes(minutes);
      toast.success(`Route saved — ${(meters / 1000).toFixed(2)} km, ~${minutes} min walk`);
    } catch {
      toast.error("Couldn't save the route. Try finishing it again.");
    }
  }

  /* ---------- Stops ---------- */

  function beginAddStop() {
    if (!activeTourId || capturingFix) return;
    setCapturingFix(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCapturingFix(false);
        setStopPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setStopTitle("");
        setRadius("25");
        setFitTrigger((t) => t + 1);
        setStopOpen(true);
      },
      (err) => {
        setCapturingFix(false);
        toast.error(geoErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function closeStopDialog() {
    if (audioRecording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
    }
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setAudioUrl(null);
    setPhotoUrl(null);
    setAudioBlob(null);
    setPhotoFile(null);
    setAudioSecs(0);
    setStopOpen(false);
  }

  async function startAudioRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        trackObjectUrl(url);
        setAudioBlob(blob);
        setAudioUrl(url);
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      };
      rec.start();
      recorderRef.current = rec;
      setAudioSecs(0);
      setAudioRecording(true);
    } catch {
      toast.error("Microphone access was denied — check browser permissions.");
    }
  }

  function stopAudioRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (audioTimerRef.current) clearInterval(audioTimerRef.current);
    audioTimerRef.current = null;
  }

  // Audio duration ticker
  useEffect(() => {
    if (audioRecording) {
      setAudioSecs(0);
      audioTimerRef.current = setInterval(() => setAudioSecs((s) => s + 1), 1000);
    }
    return () => {
      if (audioTimerRef.current) clearInterval(audioTimerRef.current);
    };
  }, [audioRecording]);

  function onPhotoSelected(file: File | undefined) {
    if (!file) return;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    const url = URL.createObjectURL(file);
    trackObjectUrl(url);
    setPhotoFile(file);
    setPhotoUrl(url);
  }

  async function saveStop() {
    if (!activeTourId || !stopPos || savingStop) return;
    const seq = stops.reduce((m, s) => Math.max(m, s.seq + 1), 0);
    const stopTitleFinal = stopTitle.trim() || `Stop ${seq + 1}`;
    const radiusM = Math.max(1, Number.isFinite(parseFloat(radius)) ? parseFloat(radius) : 25);
    setSavingStop(true);
    try {
      const fd = new FormData();
      fd.append("seq", String(seq));
      fd.append("lat", String(stopPos.lat));
      fd.append("lng", String(stopPos.lng));
      fd.append("title", stopTitleFinal);
      fd.append("trigger_radius_m", String(radiusM));
      if (audioBlob) fd.append("audio", audioBlob, "narration.webm");
      if (photoFile) fd.append("photo", photoFile, "photo.jpg");
      const res = await fetch(`/api/tours/${activeTourId}/stops`, { method: "POST", body: fd });
      if (!res.ok) throw new Error("save stop failed");
      const data: { id: number; audio_media_id: number | null; photo_media_id: number | null } =
        await res.json();
      setStops((prev) => [
        ...prev,
        {
          id: data.id,
          seq,
          lat: stopPos.lat,
          lng: stopPos.lng,
          title: stopTitleFinal,
          audio_media_id: data.audio_media_id,
          photo_media_id: data.photo_media_id,
          trigger_radius_m: radiusM,
        },
      ]);
      toast.success(`Stop ${seq + 1} added to the tour`);
      closeStopDialog();
    } catch {
      toast.error("Couldn't save the stop — try again.");
    } finally {
      setSavingStop(false);
    }
  }

  async function deleteStop(id: number) {
    try {
      const res = await fetch(`/api/stops/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      setStops((prev) => prev.filter((s) => s.id !== id));
      toast.success("Stop deleted");
    } catch {
      toast.error("Couldn't delete the stop");
    }
  }

  /* ---------- Cover photo ---------- */

  async function uploadCover(file: File | undefined) {
    if (!file || !activeTourId) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`/api/tours/${activeTourId}/cover`, { method: "POST", body: fd });
      if (!res.ok) throw new Error("upload failed");
      const data: { media_id: number } = await res.json();
      setCoverPhotoId(data.media_id);
      toast.success("Cover photo updated");
    } catch {
      toast.error("Couldn't upload the cover photo");
    }
  }

  /* ---------- Publish ---------- */

  async function togglePublished(next: boolean) {
    if (!activeTourId) return;
    try {
      const res = await fetch(`/api/tours/${activeTourId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ published: next }),
      });
      if (!res.ok) throw new Error("publish failed");
      setPublished(next);
      toast.success(
        next
          ? "Tour published — it's now visible in the marketplace."
          : "Tour set back to draft — hidden from the marketplace."
      );
    } catch {
      toast.error("Couldn't update publish state");
    }
  }

  /* ---------- Derived ---------- */

  const displayPoints: LatLng[] =
    recState !== "idle" && livePos ? [...routePoints, livePos] : routePoints;
  const liveMeters = routeDistanceMeters(routePoints);
  const sortedStops = [...stops].sort((a, b) => a.seq - b.seq);
  const disabledUntilReady = booting || !activeTourId;
  const audioMins = Math.floor(audioSecs / 60);
  const audioSecsRem = audioSecs % 60;

  if (loadError) {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur px-3 py-2.5 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDone} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </header>
        <div className="p-4 max-w-2xl mx-auto pt-16 text-center text-muted-foreground">
          <p>{loadError}</p>
          <Button className="mt-4" variant="outline" onClick={onDone}>
            Back to My Tours
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-10">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur px-3 py-2.5 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Done
        </Button>
        <div className="flex-1 text-center text-sm font-semibold truncate px-1">
          {title || "Tour Creator"}
        </div>
        <Badge variant={published ? "default" : "secondary"}>
          {published ? "Published" : "Draft"}
        </Badge>
      </header>

      <main className="max-w-2xl mx-auto p-3 space-y-4">
        {/* Tour details */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tour details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Cover photo */}
            <div className="flex items-start gap-3">
              {coverPhotoId ? (
                <img
                  src={`/api/media/${coverPhotoId}`}
                  alt="Tour cover"
                  className="w-28 h-20 rounded-lg object-cover border border-border"
                />
              ) : (
                <div className="w-28 h-20 rounded-lg border border-dashed border-border flex items-center justify-center text-muted-foreground">
                  <Camera className="h-6 w-6 opacity-50" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Cover photo</p>
                <p className="text-xs text-muted-foreground mb-2">
                  Shown in the marketplace listing.
                </p>
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    uploadCover(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                  aria-label="Upload cover photo"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={booting || !activeTourId}
                  onClick={() => coverInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4" />
                  {coverPhotoId ? "Replace" : "Upload cover"}
                </Button>
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="tour-title">Title</Label>
              <Input
                id="tour-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveDetails}
                placeholder="Give your tour a name"
                className="h-11 text-base"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tour-desc">Description</Label>
              <Textarea
                id="tour-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={saveDetails}
                rows={3}
                placeholder="What will people see and hear on this walk?"
              />
            </div>

            <div className="flex items-end justify-between gap-4">
              <div className="w-36 space-y-1.5">
                <Label htmlFor="tour-price">Price (USD)</Label>
                <Input
                  id="tour-price"
                  type="number"
                  step="0.01"
                  min="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  onBlur={saveDetails}
                  className="h-11"
                />
              </div>
              <span className="pb-2.5 text-xs text-muted-foreground">
                {parseFloat(price) > 0 ? `$${parseFloat(price).toFixed(2)}` : "Free"}
              </span>
            </div>

            <p className="text-xs text-muted-foreground" aria-live="polite">
              {detailsStatus === "saving"
                ? "Saving changes…"
                : detailsStatus === "saved"
                  ? "All changes saved"
                  : "Details save automatically when you leave a field."}
            </p>
          </CardContent>
        </Card>

        {/* Map + route recording */}
        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Footprints className="h-4 w-4" /> Route
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative z-0 h-[45vh] min-h-[320px] rounded-lg overflow-hidden border border-border">
              <MapContainer
                center={DEFAULT_CENTER}
                zoom={16}
                className="h-full w-full"
                scrollWheelZoom
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Polyline
                  positions={displayPoints.map((p) => [p.lat, p.lng] as [number, number])}
                  pathOptions={{ color: "#2563eb", weight: 5, opacity: 0.8 }}
                />
                {sortedStops.map((s) => (
                  <Circle
                    key={`r-${s.id}`}
                    center={[s.lat, s.lng]}
                    radius={s.trigger_radius_m}
                    pathOptions={{ color: "#f59e0b", weight: 1, fillOpacity: 0.08 }}
                  />
                ))}
                {sortedStops.map((s) => (
                  <Marker key={s.id} position={[s.lat, s.lng]} />
                ))}
                {livePos && <Marker position={[livePos.lat, livePos.lng]} icon={userIcon} />}
                <FollowUser pos={livePos} follow={recState === "recording"} />
                <FitAll
                  points={[...routePoints, ...sortedStops.map((s) => ({ lat: s.lat, lng: s.lng }))]}
                  trigger={fitTrigger}
                />
              </MapContainer>
            </div>

            {/* Recording status */}
            <div className="min-h-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {recState === "recording" && (
                <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" aria-hidden />
                  Recording route…
                </span>
              )}
              {recState === "paused" && (
                <span className="flex items-center gap-2 text-sm font-medium text-amber-600">
                  <Pause className="h-3.5 w-3.5" /> Paused
                </span>
              )}
              {routePoints.length > 0 && (
                <span className="text-muted-foreground">
                  {recState === "recording" || recState === "paused"
                    ? `${routePoints.length} points · ${(liveMeters / 1000).toFixed(2)} km so far`
                    : `Route: ${(savedMeters / 1000).toFixed(2)} km · ~${savedMinutes} min walk`}
                </span>
              )}
            </div>

            {geoError && (
              <p
                className="flex items-start gap-1.5 text-sm text-destructive"
                role="alert"
              >
                <CircleAlert className="h-4 w-4 mt-0.5 shrink-0" />
                {geoError}
              </p>
            )}

            {/* Recording controls */}
            {recState === "idle" ? (
              <Button
                size="lg"
                className="w-full h-12 text-base gap-2"
                disabled={disabledUntilReady}
                onClick={startWatch}
              >
                <Play className="h-5 w-5" /> Start Recording Route
              </Button>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {recState === "recording" ? (
                  <Button variant="secondary" size="lg" className="h-12" onClick={pauseRecording}>
                    <Pause className="h-5 w-5" /> Pause
                  </Button>
                ) : (
                  <Button size="lg" className="h-12" onClick={resumeRecording}>
                    <Play className="h-5 w-5" /> Resume
                  </Button>
                )}
                <Button
                  size="lg"
                  className="h-12 bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={finishRecording}
                >
                  <Square className="h-5 w-5" /> Finish Route
                </Button>
              </div>
            )}

            <Button
              variant="outline"
              size="lg"
              className="w-full h-12 text-base gap-2"
              disabled={disabledUntilReady || capturingFix}
              onClick={beginAddStop}
            >
              {capturingFix ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" /> Getting GPS fix…
                </>
              ) : (
                <>
                  <MapPin className="h-5 w-5" /> Add Stop Here
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Stops */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AudioLines className="h-4 w-4" /> Stops ({sortedStops.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sortedStops.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No stops yet. Walk to a spot and tap “Add Stop Here” to record narration and
                photos.
              </p>
            ) : (
              <ol className="divide-y">
                {sortedStops.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 py-3">
                    <span
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold"
                      aria-hidden
                    >
                      {s.seq + 1}
                    </span>
                    {s.photo_media_id && (
                      <img
                        src={`/api/media/${s.photo_media_id}`}
                        alt={s.title || `Stop ${s.seq + 1}`}
                        className="w-14 h-14 rounded-md object-cover border border-border shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium truncate">
                          {s.title || `Stop ${s.seq + 1}`}
                        </p>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          aria-label={`Delete stop ${s.title || s.seq + 1}`}
                          onClick={() => deleteStop(s.id)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ~{Math.round(s.trigger_radius_m)} m trigger radius
                      </p>
                      {s.audio_media_id && (
                        <audio
                          controls
                          preload="none"
                          src={`/api/media/${s.audio_media_id}`}
                          className="h-9 w-full max-w-[260px]"
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* Publish */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">Publish tour</p>
                  <Badge variant={published ? "default" : "secondary"}>
                    {published ? "Published" : "Draft"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {published
                    ? "Visible in the marketplace. Switch off to unpublish."
                    : "When published, anyone can find and take this tour."}
                </p>
              </div>
              <Switch
                checked={published}
                disabled={disabledUntilReady}
                onCheckedChange={togglePublished}
                aria-label={published ? "Unpublish tour" : "Publish tour"}
              />
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Add-stop dialog */}
      <Dialog open={stopOpen} onOpenChange={(open) => !open && closeStopDialog()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New stop</DialogTitle>
            <DialogDescription>
              {stopPos
                ? `Pinned at ${stopPos.lat.toFixed(5)}, ${stopPos.lng.toFixed(5)}`
                : "Waiting for GPS…"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="stop-title">Stop title</Label>
              <Input
                id="stop-title"
                value={stopTitle}
                onChange={(e) => setStopTitle(e.target.value)}
                placeholder="e.g. The old lighthouse"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Narration</Label>
              {audioRecording ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 px-3 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" aria-hidden />
                    Recording {audioMins}:{String(audioSecsRem).padStart(2, "0")}
                  </span>
                  <Button variant="destructive" size="sm" onClick={stopAudioRecording}>
                    <Square className="h-4 w-4" /> Stop
                  </Button>
                </div>
              ) : audioUrl ? (
                <div className="space-y-2">
                  <audio controls src={audioUrl} className="w-full" />
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={startAudioRecording}
                  >
                    <Mic className="h-4 w-4" /> Re-record
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="w-full h-11 gap-2"
                  onClick={startAudioRecording}
                >
                  <Mic className="h-5 w-5" /> Record narration
                </Button>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Photo</Label>
              {photoUrl ? (
                <div className="flex items-center gap-3">
                  <img
                    src={photoUrl}
                    alt="Attached stop photo"
                    className="h-20 w-20 rounded-lg object-cover border border-border"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      URL.revokeObjectURL(photoUrl);
                      setPhotoUrl(null);
                      setPhotoFile(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                </div>
              ) : (
                <>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => onPhotoSelected(e.target.files?.[0])}
                    aria-label="Attach a photo"
                  />
                  <Button
                    variant="secondary"
                    className="w-full h-11 gap-2"
                    onClick={() => photoInputRef.current?.click()}
                  >
                    <Camera className="h-4 w-4" /> Attach a photo
                  </Button>
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="stop-radius">Trigger radius (m)</Label>
              <Input
                id="stop-radius"
                type="number"
                min={1}
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">
                The stop auto-plays when a tour-taker walks this close.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={closeStopDialog}>
              Cancel
            </Button>
            <Button onClick={saveStop} disabled={savingStop} className="gap-1.5">
              {savingStop ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {savingStop ? "Saving…" : "Save Stop"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
