import { useEffect, useState } from "react";
import type { TourSummary } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Pencil, PlusCircle, MapPin } from "lucide-react";

export default function MyTours({
  onPlay,
  onEdit,
  onCreateNew,
}: {
  onPlay: (id: number) => void;
  onEdit: (id: number) => void;
  onCreateNew: () => void;
}) {
  const [tours, setTours] = useState<TourSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/tours/mine")
      .then((r) => r.json())
      .then(setTours)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-6 text-center text-muted-foreground">Loading your tours\u2026</div>;
  }

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">My Tours</h2>
        <Button onClick={onCreateNew} size="sm" className="gap-1.5">
          <PlusCircle className="h-4 w-4" />
          New Tour
        </Button>
      </div>

      {tours.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
            You haven't created any tours yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tours.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{t.title}</CardTitle>
                  <Badge variant={t.published ? "default" : "secondary"}>
                    {t.published ? "Published" : "Draft"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {t.description || "No description yet."}
                </p>
                <div className="text-xs text-muted-foreground">
                  {(t.distance_meters / 1000).toFixed(1)} km \u00b7 {t.estimated_minutes} min \u00b7{" "}
                  {t.price_cents === 0 ? "Free" : `$${(t.price_cents / 100).toFixed(2)}`}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1 gap-1.5" onClick={() => onEdit(t.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button size="sm" className="flex-1 gap-1.5" onClick={() => onPlay(t.id)}>
                    <Play className="h-3.5 w-3.5" />
                    Preview
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
