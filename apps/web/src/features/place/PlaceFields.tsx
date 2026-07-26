/**
 * Pure display of a place's fields. Manual pins are labeled as owner-provided;
 * healthy OSM-backed places carry no state marker (spec/src/map-view.md).
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
  state?: ResolutionState;
  /** Fixed clock for stories/tests so open-now rendering is deterministic. */
  now?: Date;
}

export function PlaceFields(props: PlaceFieldsProps) {
  const { name, category, address, website, phone, openingHours, source, state, now } = props;
  return (
    <div data-testid="place-fields">
      <div className="flex items-start justify-between gap-2 pr-7">
        <h2 className="text-lg font-semibold text-ink">{name ?? "Unnamed place"}</h2>
        {state ? <StateBadge state={state} /> : null}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        {category ? <span className="text-sm capitalize text-ink-3">{category}</span> : null}
        {openingHours ? (
          <OpenNow openingHours={openingHours} {...(now ? { at: now } : {})} />
        ) : null}
      </div>
      {source === "manual" ? (
        <p className="mt-1 text-xs text-clay-ink" data-testid="manual-note">
          Owner-provided details — not linked to OpenStreetMap
        </p>
      ) : null}
      <dl className="mt-3 space-y-1.5 text-sm">
        {address ? (
          <div>
            <dt className="sr-only">Address</dt>
            <dd className="text-ink-2">{address}</dd>
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
                className="break-all text-water-ink underline"
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
              <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="text-water-ink underline">
                {phone}
              </a>
            </dd>
          </div>
        ) : null}
        {openingHours ? (
          <div>
            <dt className="sr-only">Opening hours</dt>
            <dd className="text-ink-2">{openingHours}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
