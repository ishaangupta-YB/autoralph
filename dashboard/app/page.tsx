import Dashboard from "@/components/Board";
import { boardBaseUrl, isDemoMode } from "@/lib/board";

export const dynamic = "force-dynamic";

export default function Home() {
  return <Dashboard boardUrl={boardBaseUrl()} demo={isDemoMode()} />;
}
