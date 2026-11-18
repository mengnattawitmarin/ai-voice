import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@/components/editor-view";
import { useToast } from "@/lib/host";
import "./styles.css";

function App() {
  const msg = useToast();
  return (
    <div className="relative mx-auto flex h-dvh max-w-lg flex-col overflow-hidden text-fg">
      <main className="min-h-0 flex-1">
        <EditorView />
      </main>
      {msg ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[80] flex justify-center px-4">
          <p className="rise rounded-full bg-gold-grad px-4 py-2 text-sm font-medium text-accent-fg shadow-lg">{msg}</p>
        </div>
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
