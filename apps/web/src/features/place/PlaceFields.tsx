/**
 * Pure display of a place's fields. The `source` label matters: copied evidence and
 * manual facts are never presented as live data (book/src/place-identity.md).
 */
import type { ResolutionState } from "@placemarks/domain";
import { OpenNow } from "./OpenNow";
import { StateBadge } from "./StateBadge";

export interface PlaceFieldsProps {
  name?: string;
  category?: string;
  address?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  source: "live" | "osm-evidence" | "manual";
  observedAt?: string;
  state?: ResolutionState;
  /** Fixed clock for stories/tests so open-now rendering is deterministic. */
  now?: Date;
}

export function PlaceFields(props: PlaceFieldsProps) {
  const { name, category, address, website, phone, openingHours, source, observedAt, state, now } =
    props;
  return (
    <div data-testid="place-fields">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-900">{name ?? "Unnamed place"}</h2>
        {state ? <StateBadge state={state} /> : null}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        {category ? <span className="text-sm capitalize text-stone-500">{category}</span> : null}
        {openingHours ? (
          <OpenNow openingHours={openingHours} {...(now ? { at: now } : {})} />
        ) : null}
      </div>
      {source === "osm-evidence" && observedAt ? (
        <p className="mt-1 text-xs text-stone-500" data-testid="evidence-note">
          Showing saved OSM data from {new Date(observedAt).toLocaleDateString()}
        </p>
      ) : null}
      {source === "manual" ? (
        <p className="mt-1 text-xs text-orange-700" data-testid="manual-note">
          Owner-provided details — not linked to OpenStreetMap
        </p>
      ) : null}
      <dl className="mt-3 space-y-1.5 text-sm">
        {address ? (
          <div>
            <dt className="sr-only">Address</dt>
            <dd className="text-stone-700">{address}</dd>
          </div>
        ) : null}
        {website ? (
          <div>
            <dt className="sr-only">Website</dt>
            <dd>
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                className="break-all text-blue-700 underline"
                data-testid="website-link"
              >
                {website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            </dd>
          </div>
        ) : null}
        {phone ? (
          <div>
            <dt className="sr-only">Phone</dt>
            <dd>
              <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="text-blue-700 underline">
                {phone}
              </a>
            </dd>
          </div>
        ) : null}
        {openingHours ? (
          <div>
            <dt className="sr-only">Opening hours</dt>
            <dd className="text-stone-600">{openingHours}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
