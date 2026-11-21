import type {
  HarvestPhoto,
  HarvestProvider,
  HarvestReview,
  PlaceSnapshot,
} from "@placemarks/schemas";

/** One line of work: a Google Maps place URL, or a free-text search. */
export interface HarvestInput {
  /** A place URL (`https://www.google.com/maps/place/…`) or a search query. */
  query: string;
  kind: "url" | "search";
  /** The Takeout list (CSV file name) the input came from, if any. */
  list?: string;
  /** The row title, for the run report. */
  title?: string;
}

export interface SearchArea {
  /** Centre of a radius search. */
  geo?: { lat: number; lng: number };
  radiusMeters?: number;
  /** minLat,minLng,maxLat,maxLng — grid search inside a box. */
  bbox?: [number, number, number, number];
}

export interface HarvestOptions {
  /** Ask the provider for as many reviews as it can reach. */
  extraReviews: boolean;
  /** Search results per query (scroll depth for the self-hosted scraper). */
  depth: number;
  area?: SearchArea;
  language: string;
  /** Scratch directory the provider may use for its raw output. */
  workDir: string;
  signal?: AbortSignal;
}

/** Everything harvested for one place, already in the dataset shape. */
export interface HarvestedPlace {
  /** Index into the inputs array this place answers. */
  inputIndex: number;
  place: PlaceSnapshot;
  reviews: HarvestReview[];
  photos: HarvestPhoto[];
}

export interface ProviderResult {
  places: HarvestedPlace[];
  /** Inputs the provider could not process, by index. */
  failures: { inputIndex: number; error: string }[];
}

/**
 * A source of Google Maps place facts and reviews. Providers are batch-shaped
 * because the self-hosted scraper and the paid APIs all work best that way;
 * the CLI does chunking, pacing and the daily cap around them.
 */
export interface Provider {
  readonly name: HarvestProvider;
  harvest(inputs: HarvestInput[], options: HarvestOptions): Promise<ProviderResult>;
}
