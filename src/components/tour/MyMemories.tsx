import { useEffect, useState } from "react";
import type { SavedMediaItem } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Images } from "lucide-react";

export default function MyMemories() {
  const [items, setItems] = useState<SavedMediaItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/saved-media")
      .then((r) => r.json())
      .then(setItems)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-6 text-center text-muted-foreground">Loading your memories\u2026</div>;
  }

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <h2 className="text-xl font-semibold">My Memories</h2>
      <p className="text-sm text-muted-foreground">
        Photos and audio you captured while touring \u2014 saved for you to relive or share.
      </p>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <Images className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No saved memories yet. Capture photos or audio during a tour to see them here.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {items.map((item) => (
            <Card key={item.id} className="overflow-hidden">
              {item.media_type === "photo" ? (
                <img src={`/api/media/${item.media_id}`} alt="" className="w-full aspect-square object-cover" />
              ) : (
                <div className="p-3 space-y-2">
                  <audio controls src={`/api/media/${item.media_id}`} className="w-full" />
                </div>
              )}
              <CardContent className="p-2">
                <p className="text-xs font-medium truncate">{item.tour_title}</p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(item.captured_at).toLocaleDateString()}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
