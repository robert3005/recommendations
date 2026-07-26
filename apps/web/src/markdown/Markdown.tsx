/**
 * The one Markdown pipeline (spec/src/posts.md §The body): remark-parse +
 * remark-gfm → rehype-sanitize with an allowlist schema; raw HTML disabled;
 * images are out entirely. Local mode allowlists http:/https:/place:/post:
 * link protocols; viewer mode (public pages) allowlists only http:/https: and
 * # fragments — published bodies never contain custom protocols
 * (spec/src/sharing.md §Publish-time link rewrite). place:/post: links are
 * soft: a dangling or out-of-projection target renders as plain text.
 */
import { PLACE_PROTOCOL, POST_PROTOCOL } from "@placemarks/domain";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export type MarkdownMode = "local" | "viewer";

// No images in post bodies: strip the tag itself, not just its src.
const tagNames = (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img");

const localSchema = {
  ...defaultSchema,
  tagNames,
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "place", "post"] },
};

const viewerSchema = {
  ...defaultSchema,
  tagNames,
  protocols: { ...defaultSchema.protocols, href: ["http", "https"] },
};

export interface MarkdownProps {
  body: string;
  /** "local" (default): the app's own surfaces. "viewer": public pages. */
  mode?: MarkdownMode;
  /**
   * place: targets that resolve — the post's projection. Mentions outside it
   * render as plain text (spec/src/posts.md §Projection).
   */
  placeIds?: ReadonlySet<string>;
  /** post: targets that resolve; a dangling cross-post link is plain text. */
  postIds?: ReadonlySet<string>;
  /** The mention highlighted by the current pin↔mention selection. */
  selectedPlaceId?: string;
  onPlaceClick?: (placeId: string) => void;
  onPostClick?: (postId: string) => void;
  /** Viewer mode: intercept #place-<id> fragments for pin focus. */
  onFragmentClick?: (fragment: string) => void;
}

export function Markdown({
  body,
  mode = "local",
  placeIds,
  postIds,
  selectedPlaceId,
  onPlaceClick,
  onPostClick,
  onFragmentClick,
}: MarkdownProps) {
  const components: Components = {
    // GFM task-list checkboxes render as bare inputs — label them for AT.
    input: (props) =>
      props.type === "checkbox" ? (
        <input
          type="checkbox"
          checked={props.checked === true}
          disabled
          readOnly
          aria-label={props.checked === true ? "completed task" : "open task"}
        />
      ) : null,
    a: ({ href, children }) => {
      // Stripped by urlTransform/sanitizer — soft links degrade to plain text.
      if (!href) return <span>{children}</span>;
      if (href.startsWith(PLACE_PROTOCOL)) {
        const placeId = href.slice(PLACE_PROTOCOL.length);
        if (!placeIds?.has(placeId)) return <span>{children}</span>;
        return (
          <button
            type="button"
            data-mention-place={placeId}
            aria-current={selectedPlaceId === placeId ? "true" : undefined}
            className={`cursor-pointer font-medium text-ink underline decoration-dotted underline-offset-2 ${
              selectedPlaceId === placeId ? "bg-hairline" : ""
            }`}
            onClick={() => onPlaceClick?.(placeId)}
          >
            {children}
          </button>
        );
      }
      if (href.startsWith(POST_PROTOCOL)) {
        const postId = href.slice(POST_PROTOCOL.length);
        if (!postIds?.has(postId)) return <span>{children}</span>;
        return (
          <button
            type="button"
            data-post-link={postId}
            className="cursor-pointer font-medium text-ink underline underline-offset-2"
            onClick={() => onPostClick?.(postId)}
          >
            {children}
          </button>
        );
      }
      if (href.startsWith("#")) {
        // Viewer mode only: local mode's transform strips fragments.
        return (
          <a
            href={href}
            data-fragment-link={href.slice(1)}
            className="font-medium text-ink underline decoration-dotted underline-offset-2"
            onClick={(event) => {
              if (!onFragmentClick) return;
              event.preventDefault();
              onFragmentClick(href);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-ink underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className="prose prose-sm max-w-none font-body [&_table]:block [&_table]:overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, mode === "viewer" ? viewerSchema : localSchema]]}
        components={components}
        urlTransform={(url, key) => {
          // Images are out; href is the only URL-bearing attribute that survives.
          if (key !== "href") return null;
          if (/^https?:/i.test(url)) return url;
          if (mode === "local") return /^(place|post):/i.test(url) ? url : null;
          return url.startsWith("#") ? url : null;
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
