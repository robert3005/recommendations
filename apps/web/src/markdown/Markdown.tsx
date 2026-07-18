/**
 * The one Markdown pipeline (book/src/notes.md): CommonMark+GFM → sanitized HTML.
 * Raw HTML is disabled; remote images are blocked — images must use app-controlled
 * asset: ids; external links get hardened rel attributes.
 */
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useRepo } from "../data/RepoContext";

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [["src"], ["alt"]],
  },
  // The sanitizer strips src values whose protocol is not allowlisted; app images
  // use asset: ids exclusively (http/https images are already dropped in urlTransform).
  protocols: { ...defaultSchema.protocols, src: ["asset"] },
};

function AssetImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const repo = useRepo();
  const [url, setUrl] = useState<string>();
  const assetId = typeof src === "string" && src.startsWith("asset:") ? src.slice(6) : undefined;

  useEffect(() => {
    if (!assetId) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    void repo.getMedia(assetId).then((media) => {
      if (media && !cancelled) {
        objectUrl = URL.createObjectURL(media.blob);
        setUrl(objectUrl);
      }
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, repo]);

  // Remote/unknown image sources are dropped entirely.
  if (!assetId) return null;
  if (!url) return <span className="text-xs text-stone-400">loading image…</span>;
  return <img src={url} alt={alt ?? ""} className="max-w-full rounded-lg" />;
}

const components: Components = {
  img: (props) => (
    <AssetImage
      {...(props.src ? { src: props.src } : {})}
      {...(props.alt ? { alt: props.alt } : {})}
    />
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      className="text-blue-700 underline"
    >
      {children}
    </a>
  ),
};

export function Markdown({ body }: { body: string }) {
  return (
    <div className="prose prose-sm prose-stone max-w-none [&_table]:block [&_table]:overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
        urlTransform={(url, key) => {
          if (key === "src") return url.startsWith("asset:") ? url : null;
          if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
          return null;
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
