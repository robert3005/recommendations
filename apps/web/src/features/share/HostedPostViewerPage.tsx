/**
 * Hosted post viewer route `/p/:slug` (spec/src/posts.md §Publishing): the
 * post projection of the shared block document, fetched from /s/posts —
 * public, read-only, noindex. Pre-pivot guide documents keep serving from
 * /l/:slug; this route is the post projection's home.
 */
import { sharedGuideSchema } from "@placemarks/schemas";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { SHARE_API_URL } from "../../config";
import { EmptySharedCanvasProjection } from "../../state/projection";
import { SharedGuideView } from "./SharedGuideView";
import { useNoindex } from "./useNoindex";

export function HostedPostViewerPage() {
  const { slug } = useParams({ from: "/p/$slug" });
  useNoindex();
  const postQuery = useQuery({
    queryKey: ["hosted-post", slug],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${SHARE_API_URL}/s/posts/${slug}`, { signal });
      if (response.status === 404) throw new Error("gone");
      if (!response.ok) throw new Error("unavailable");
      return sharedGuideSchema.parse(await response.json());
    },
    retry: 1,
  });

  if (postQuery.isPending) {
    return (
      <>
        <EmptySharedCanvasProjection />
        <p className="p-6 text-sm text-stone-500">Loading shared post…</p>
      </>
    );
  }
  if (postQuery.isError) {
    const gone = postQuery.error.message === "gone";
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptySharedCanvasProjection />
        <p className="max-w-sm text-center text-sm text-stone-600" data-testid="hosted-error">
          <span className="font-semibold text-stone-800">
            {gone ? "This shared post is no longer available." : "Could not load this post."}
          </span>{" "}
          {gone
            ? "Its creator may have unpublished it."
            : "The share service is unreachable — try again shortly."}
        </p>
      </div>
    );
  }
  return <SharedGuideView guide={postQuery.data} mode="hosted" />;
}
