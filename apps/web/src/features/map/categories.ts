/**
 * The top-level filter chips (book/src/map-view.md §Layout): the detailed OSM
 * taxonomy maps into a small adopted set — [Eat] [Drink] [Shop] [Stay]
 * [Culture] [Health]. Unknown categories stay visible under every filter-off
 * state and simply match no chip.
 */

export const TOP_CATEGORIES = [
  { key: "eat", label: "Eat" },
  { key: "drink", label: "Drink" },
  { key: "shop", label: "Shop" },
  { key: "stay", label: "Stay" },
  { key: "culture", label: "Culture" },
  { key: "health", label: "Health" },
] as const;

export type TopCategory = (typeof TOP_CATEGORIES)[number]["key"];

const MAPPING: Record<TopCategory, readonly string[]> = {
  eat: [
    "restaurant",
    "cafe",
    "fast_food",
    "food_court",
    "ice_cream",
    "bakery",
    "deli",
    "confectionery",
    "pastry",
  ],
  drink: ["bar", "pub", "biergarten", "nightclub", "wine_bar", "brewery"],
  shop: [
    "supermarket",
    "convenience",
    "mall",
    "marketplace",
    "department_store",
    "clothes",
    "shoes",
    "books",
    "gift",
    "greengrocer",
    "butcher",
    "cheese",
    "wine",
    "shop",
  ],
  stay: [
    "hotel",
    "hostel",
    "guest_house",
    "apartment",
    "motel",
    "camp_site",
    "caravan_site",
    "chalet",
  ],
  culture: [
    "museum",
    "gallery",
    "artwork",
    "attraction",
    "theatre",
    "cinema",
    "viewpoint",
    "monument",
    "memorial",
    "castle",
    "ruins",
    "archaeological_site",
    "place_of_worship",
    "arts_centre",
    "library",
  ],
  health: ["pharmacy", "hospital", "clinic", "doctors", "dentist", "veterinary", "spa"],
};

const byDetail = new Map<string, TopCategory>();
for (const [top, details] of Object.entries(MAPPING) as [TopCategory, readonly string[]][]) {
  for (const detail of details) byDetail.set(detail, top);
}

/** The chip a detailed OSM category belongs to, if any. */
export function topCategoryOf(category: string): TopCategory | undefined {
  return byDetail.get(category.toLowerCase());
}
