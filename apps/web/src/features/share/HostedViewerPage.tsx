/**
 * Mode B viewer route `/l/:slug` (spec/src/sharing.md): fetches the latest
 * successfully published revision — public, read-only, noindex. A revoked or
 * unknown slug gets a designed error, never a blank page.
 */
import { sharedGuideSchema } from "@placemarks/schemas";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { SHARE_API_URL } from "../../config";
import { EmptySharedCanvasProjection } from "../../state/projection";
import { SharedGuideView } from "./SharedGuideView";
import { useNoindex } from "./useNoindex";

export function HostedViewerPage() {
  const { slug } = useParams({ from: "/l/$slug" });
  useNoindex();
  const guideQuery = useQuery({
    queryKey: ["hosted-guide", slug],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${SHARE_API_URL}/s/lists/${slug}`, { signal });
      if (response.status === 404) throw new Error("gone");
      if (!response.ok) throw new Error("unavailable");
      return sharedGuideSchema.parse(await response.json());
    },
    retry: 1,
  });

  if (guideQuery.isPending) {
    return (
      <>
        <EmptySharedCanvasProjection />
        <p className="p-6 text-sm text-ink-3">Loading shared page…</p>
      </>
    );
  }
  if (guideQuery.isError) {
    const gone = guideQuery.error.message === "gone";
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptySharedCanvasProjection />
        <p className="max-w-sm text-center text-sm text-ink-2" data-testid="hosted-error">
          <span className="font-semibold text-ink">
            {gone ? "This shared page is no longer available." : "Could not load this shared page."}
          </span>{" "}
          {gone
            ? "Its creator may have unpublished it."
            : "The share service is unreachable — try again shortly."}
        </p>
      </div>
    );
  }
  return <SharedGuideView guide={guideQuery.data} mode="hosted" />;
}
