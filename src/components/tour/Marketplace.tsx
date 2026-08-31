import { useEffect, useMemo, useState } from "react";
import type { TourSummary, TourDetail } from "@/types";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Clock,
  Compass,
  Footprints,
  ImageOff,
  Loader2,
  MapPin,
  ShoppingBag,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Leaflet's default marker icon paths break under Vite bundling — fix once here.
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: icon,
  shadowUrl: iconShadow,
});

const DEFAULT_CENTER: [number, number] = [40.7128, -74.006];

function fmtDistance(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

function fmtPrice(priceCents: number): string {
  return priceCents === 0 ? "Free" : `$${(priceCents / 100).toFixed(2)}`;
}

/** Cover photo with graceful fallback when missing or unloadable. */
function TourCover({
  coverPhotoId,
  alt,
  className,
}: {
  coverPhotoId: number | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (coverPhotoId === null || failed) {
    return (
      <div
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground",
          className
        )}
      >
        <ImageOff className="h-6 w-6 opacity-60" />
      </div>
    );
  }

  return (
    <img
      src={`/api/media/${coverPhotoId}`}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("object-cover", className)}
    />
  );
}

function TourMeta({ tour, className }: { tour: TourSummary; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
        className
      )}
    >
      <span className="inline-flex items-center gap-1">
        <Footprints className="h-3.5 w-3.5" aria-hidden="true" />
        {fmtDistance(tour.distance_meters)}
      </span>
      <span className="inline-flex items-center gap-1">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
        {tour.estimated_minutes} min
      </span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <User className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{tour.creator_name ?? "Unknown guide"}</span>
      </span>
    </div>
  );
}

/** Fits the map to all tour start points (single point → centered view). */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 1) {
      map.setView(points[0], 14);
    } else if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48] });
    }
  }, [map, points]);

  return null;
}

export default function Marketplace({ onPlay }: { onPlay: (tourId: number) => void }) {
  const [tours, setTours] = useState<TourSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [checkout, setCheckout] = useState<TourSummary | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tours")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load tours (${r.status})`);
        return r.json();
      })
      .then((data: TourSummary[]) => {
        if (!cancelled) setTours(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Failed to load tours");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const points = useMemo(
    () =>
      tours
        .filter((t) => t.start_lat !== null && t.start_lng !== null)
        .map((t) => [t.start_lat, t.start_lng] as [number, number]),
    [tours]
  );

  async function openTour(tourId: number) {
    if (openingId !== null || purchasing) return;
    setOpeningId(tourId);
    try {
      const r = await fetch(`/api/tours/${tourId}`);
      if (!r.ok) throw new Error(`Could not load tour (${r.status})`);
      const detail: TourDetail = await r.json();
      if (detail.unlocked) {
        onPlay(tourId);
      } else {
        setCheckout(detail.tour);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not open tour");
    } finally {
      setOpeningId(null);
    }
  }

  async function confirmPurchase() {
    if (!checkout) return;
    setPurchasing(true);
    try {
      const r = await fetch(`/api/tours/${checkout.id}/purchase`, { method: "POST" });
      if (!r.ok) throw new Error(`Purchase failed (${r.status})`);
      const target = checkout.id;
      setCheckout(null);
      onPlay(target);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setPurchasing(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4">
        <div className="mb-4 space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[45vh] rounded-xl lg:h-[560px]" />
          <div className="grid content-start gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const center: [number, number] = points.length > 0 ? points[0] : DEFAULT_CENTER;

  return (
    <div className="mx-auto w-full max-w-7xl p-4 lg:h-[calc(100vh-8.5rem)]">
      <div className="mb-4 flex items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Compass className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Explore tours
          </h2>
          <p className="text-sm text-muted-foreground">
            {tours.length} {tours.length === 1 ? "walk" : "walks"} published by the community
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:h-[calc(100%-4.25rem)] lg:flex-row">
        {/* Map pane — z-0 stacking context keeps Leaflet internals below dialogs */}
        <div className="relative z-0 h-[45vh] shrink-0 overflow-hidden rounded-xl border border-border shadow-sm lg:h-full lg:w-1/2">
          <MapContainer
            center={center}
            zoom={points.length > 0 ? 13 : 12}
            scrollWheelZoom={false}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitBounds points={points} />
            {tours.map(
              (t) =>
                t.start_lat !== null &&
                t.start_lng !== null && (
                  <Marker key={t.id} position={[t.start_lat, t.start_lng]}>
                    <Popup className="[&_.leaflet-popup-content-wrapper]:rounded-xl [&_.leaflet-popup-content-wrapper]:bg-card [&_.leaflet-popup-content-wrapper]:text-card-foreground [&_.leaflet-popup-content]:!mx-4 [&_.leaflet-popup-content]:!my-3 [&_.leaflet-popup-content]:!p-0 [&_.leaflet-popup-tip]:bg-card">
                      <div className="w-56 space-y-2">
                        <TourCover
                          coverPhotoId={t.cover_photo_id}
                          alt={t.title}
                          className="h-24 w-full rounded-md"
                        />
                        <div className="space-y-0.5">
                          <p className="font-semibold leading-tight">{t.title}</p>
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {t.description || "No description yet."}
                          </p>
                        </div>
                        <TourMeta tour={t} />
                        <div className="flex items-center justify-between">
                          <Badge variant={t.price_cents === 0 ? "secondary" : "default"}>
                            {fmtPrice(t.price_cents)}
                          </Badge>
                          <Button size="sm" onClick={() => openTour(t.id)}>
                            View tour
                          </Button>
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                )
            )}
          </MapContainer>
        </div>

        {/* Tour list */}
        <div className="min-w-0 flex-1 lg:overflow-y-auto lg:pr-1">
          {tours.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <MapPin className="mx-auto mb-3 h-10 w-10 opacity-50" aria-hidden="true" />
                <p className="font-medium text-foreground">No tours yet</p>
                <p className="mt-1 text-sm">Be the first to create one!</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid content-start gap-4 sm:grid-cols-2">
              {tours.map((t) => (
                <Card key={t.id} className="flex flex-col overflow-hidden">
                  <TourCover
                    coverPhotoId={t.cover_photo_id}
                    alt={t.title}
                    className="aspect-[16/9] w-full shrink-0"
                  />
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base leading-snug">{t.title}</CardTitle>
                      <Badge variant={t.price_cents === 0 ? "secondary" : "default"} className="shrink-0">
                        {fmtPrice(t.price_cents)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="mt-auto space-y-3 pb-4">
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {t.description || "No description yet."}
                    </p>
                    <TourMeta tour={t} />
                    <Button
                      size="sm"
                      className="w-full gap-1.5"
                      disabled={openingId !== null || purchasing}
                      onClick={() => openTour(t.id)}
                    >
                      {openingId === t.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {openingId === t.id ? "Opening…" : "View / Start"}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Mock checkout for paid, locked tours */}
      <Dialog
        open={checkout !== null}
        onOpenChange={(open) => {
          if (!open && !purchasing) setCheckout(null);
        }}
      >
        <DialogContent className="max-w-sm">
          {checkout && (
            <>
              <DialogHeader>
                <DialogTitle>{checkout.title}</DialogTitle>
                <DialogDescription>
                  Buy for {fmtPrice(checkout.price_cents)} — mock checkout, no real payment yet.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                  {fmtDistance(checkout.distance_meters)} · {checkout.estimated_minutes} min
                </span>
                <span className="font-semibold">{fmtPrice(checkout.price_cents)}</span>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  disabled={purchasing}
                  onClick={() => setCheckout(null)}
                >
                  Cancel
                </Button>
                <Button onClick={confirmPurchase} disabled={purchasing} className="gap-1.5">
                  {purchasing && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  Confirm purchase
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
