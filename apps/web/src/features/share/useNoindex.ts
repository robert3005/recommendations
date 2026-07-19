/** Public share pages default to noindex (book/src/sharing.md). */
import { useEffect } from "react";

export function useNoindex(): void {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}
