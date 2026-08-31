import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth";
import type { AuthUser } from "./types";
import AuthScreen from "@/components/AuthScreen";
import Marketplace from "@/components/tour/Marketplace";
import TourCreator from "@/components/tour/TourCreator";
import TourPlayer from "@/components/tour/TourPlayer";
import MyTours from "@/components/tour/MyTours";
import MyMemories from "@/components/tour/MyMemories";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Compass, Map, PlusCircle, Images, LogOut } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";

type Tab = "explore" | "my-tours" | "create" | "memories";

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("explore");
  const [playingTourId, setPlayingTourId] = useState<number | null>(null);
  const [editingTourId, setEditingTourId] = useState<number | null>(null);

  async function refreshUser() {
    const { data } = await authClient.getSession();
    if (data?.session && data?.user) {
      setUser(data.user as AuthUser);
    } else {
      setUser(null);
    }
    setChecking(false);
  }

  useEffect(() => {
    refreshUser();
  }, []);

  async function handleSignOut() {
    await authClient.signOut();
    setUser(null);
  }

  if (checking) {
    return <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">Loading\u2026</div>;
  }

  if (!user) {
    return (
      <>
        <AuthScreen onAuthed={refreshUser} />
        <Toaster />
      </>
    );
  }

  if (playingTourId !== null) {
    return (
      <>
        <TourPlayer tourId={playingTourId} onExit={() => setPlayingTourId(null)} />
        <Toaster />
      </>
    );
  }

  if (editingTourId !== null) {
    return (
      <>
        <TourCreator
          tourId={editingTourId}
          onDone={() => {
            setEditingTourId(null);
            setTab("my-tours");
          }}
        />
        <Toaster />
      </>
    );
  }

  const navItems: { id: Tab; label: string; icon: typeof Compass }[] = [
    { id: "explore", label: "Explore", icon: Compass },
    { id: "my-tours", label: "My Tours", icon: Map },
    { id: "create", label: "Create", icon: PlusCircle },
    { id: "memories", label: "Memories", icon: Images },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-foreground">Walking Tour Guide</h1>
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="gap-1.5">
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </header>

      <nav className="border-b border-border px-2 flex gap-1 overflow-x-auto">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
              tab === item.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-auto">
        {tab === "explore" && <Marketplace onPlay={(id) => setPlayingTourId(id)} />}
        {tab === "my-tours" && (
          <MyTours
            onPlay={(id) => setPlayingTourId(id)}
            onEdit={(id) => setEditingTourId(id)}
            onCreateNew={() => setTab("create")}
          />
        )}
        {tab === "create" && (
          <TourCreator
            onDone={() => {
              setEditingTourId(null);
              setTab("my-tours");
            }}
          />
        )}
        {tab === "memories" && <MyMemories />}
      </main>
      <Toaster />
    </div>
  );
}

export default App;
