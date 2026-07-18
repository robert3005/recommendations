/**
 * A list, read-only: the Lists surface is for reading (book/src/map-view.md).
 * All list mutations happen from place cards; richer editing returns with the
 * guide milestone.
 */
import { displayFacts } from "@placemarks/domain";
import { useParams } from "@tanstack/react-router";
import { useGuide, useGuideBlocks } from "../../data/hooks";
import { StateBadge } from "../place/StateBadge";

export function ListPage() {
  const { listId } = useParams({ from: "/lists/$listId" });
  const list = useGuide(listId);
  const blocks = useGuideBlocks(listId);

  if (!list) return <div className="p-4 text-stone-500">List not found.</div>;

  const placeBlocks = (blocks ?? []).filter((v) => v.block.content.type === "place");

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="list-page">
      <h1 className="text-xl font-semibold text-stone-900">{list.name}</h1>

      <ul className="mt-4 space-y-2">
        {placeBlocks.map((view) => {
          const facts = view.place ? displayFacts(view.place) : undefined;
          return (
            <li
              key={view.block.id}
              className="rounded-lg border border-stone-200 bg-stone-50 p-3"
              data-testid="place-item"
            >
              <span className="font-medium text-stone-900">{facts?.name ?? "Missing place"}</span>
              {facts?.category ? (
                <span className="ml-2 text-xs capitalize text-stone-500">{facts.category}</span>
              ) : null}
              {view.place ? (
                <span className="ml-2">
                  <StateBadge state={view.place.resolutionState} />
                </span>
              ) : null}
              {facts?.address ? (
                <span className="block text-sm text-stone-600">{facts.address}</span>
              ) : null}
              {facts?.website ? (
                <a
                  href={facts.website}
                  target="_blank"
                  rel="noopener noreferrer nofollow ugc"
                  className="block text-sm text-blue-700 underline"
                >
                  {facts.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              ) : null}
            </li>
          );
        })}
        {blocks !== undefined && placeBlocks.length === 0 ? (
          <li className="py-4 text-sm text-stone-500">
            Nothing here yet — add places to this list from their cards on the map.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
