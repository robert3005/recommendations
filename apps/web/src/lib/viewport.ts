/**
 * The starting camera (spec/src/map-view.md): the last viewport when one is
 * stored; otherwise an **approximate location derived locally from the device
 * timezone** — no permission prompt, no network request, nothing leaves the
 * device. Precise location stays behind the user-triggered Locate button.
 */

export interface Viewport {
  lng: number;
  lat: number;
  zoom: number;
}

/** World view fallback when the timezone is unknown. */
const WORLD: Viewport = { lng: 0, lat: 25, zoom: 1.6 };

const CITY_ZOOM = 10;
const REGION_ZOOM = 4;

/** IANA zone → rough city-centre coordinates for common zones. */
const ZONE_CENTERS: Record<string, [lng: number, lat: number]> = {
  "Europe/Lisbon": [-9.14, 38.72],
  "Europe/London": [-0.12, 51.5],
  "Europe/Dublin": [-6.26, 53.35],
  "Europe/Paris": [2.35, 48.86],
  "Europe/Madrid": [-3.7, 40.42],
  "Europe/Barcelona": [2.17, 41.39],
  "Europe/Berlin": [13.4, 52.52],
  "Europe/Amsterdam": [4.9, 52.37],
  "Europe/Brussels": [4.35, 50.85],
  "Europe/Zurich": [8.54, 47.37],
  "Europe/Rome": [12.5, 41.9],
  "Europe/Vienna": [16.37, 48.21],
  "Europe/Prague": [14.42, 50.09],
  "Europe/Warsaw": [21.01, 52.23],
  "Europe/Stockholm": [18.07, 59.33],
  "Europe/Oslo": [10.75, 59.91],
  "Europe/Copenhagen": [12.57, 55.68],
  "Europe/Helsinki": [24.94, 60.17],
  "Europe/Athens": [23.73, 37.98],
  "Europe/Istanbul": [28.98, 41.01],
  "Europe/Budapest": [19.04, 47.5],
  "Europe/Bucharest": [26.1, 44.43],
  "Europe/Kyiv": [30.52, 50.45],
  "America/New_York": [-74.01, 40.71],
  "America/Toronto": [-79.38, 43.65],
  "America/Montreal": [-73.57, 45.5],
  "America/Chicago": [-87.63, 41.88],
  "America/Denver": [-104.99, 39.74],
  "America/Phoenix": [-112.07, 33.45],
  "America/Los_Angeles": [-118.24, 34.05],
  "America/Vancouver": [-123.12, 49.28],
  "America/Mexico_City": [-99.13, 19.43],
  "America/Bogota": [-74.07, 4.71],
  "America/Lima": [-77.04, -12.05],
  "America/Santiago": [-70.67, -33.45],
  "America/Argentina/Buenos_Aires": [-58.38, -34.6],
  "America/Sao_Paulo": [-46.63, -23.55],
  "America/Halifax": [-63.58, 44.65],
  "Africa/Cairo": [31.24, 30.04],
  "Africa/Lagos": [3.39, 6.45],
  "Africa/Nairobi": [36.82, -1.29],
  "Africa/Johannesburg": [28.05, -26.2],
  "Africa/Casablanca": [-7.59, 33.57],
  "Asia/Jerusalem": [35.21, 31.77],
  "Asia/Dubai": [55.27, 25.2],
  "Asia/Riyadh": [46.68, 24.71],
  "Asia/Karachi": [67.01, 24.86],
  "Asia/Kolkata": [77.21, 28.61],
  "Asia/Dhaka": [90.41, 23.81],
  "Asia/Bangkok": [100.5, 13.76],
  "Asia/Jakarta": [106.85, -6.21],
  "Asia/Singapore": [103.85, 1.29],
  "Asia/Kuala_Lumpur": [101.69, 3.14],
  "Asia/Manila": [120.98, 14.6],
  "Asia/Hong_Kong": [114.17, 22.32],
  "Asia/Shanghai": [121.47, 31.23],
  "Asia/Taipei": [121.57, 25.03],
  "Asia/Seoul": [126.98, 37.57],
  "Asia/Tokyo": [139.69, 35.69],
  "Australia/Sydney": [151.21, -33.87],
  "Australia/Melbourne": [144.96, -37.81],
  "Australia/Brisbane": [153.03, -27.47],
  "Australia/Perth": [115.86, -31.95],
  "Pacific/Auckland": [174.76, -36.85],
  "Pacific/Honolulu": [-157.86, 21.31],
};

/** Continent-level fallback for zones not in the city table. */
const REGION_CENTERS: Record<string, [lng: number, lat: number]> = {
  Europe: [10, 50],
  America: [-90, 30],
  Africa: [20, 5],
  Asia: [90, 30],
  Australia: [134, -26],
  Pacific: [170, -20],
  Indian: [73, -5],
  Atlantic: [-20, 30],
};

/** Approximate start derived from the device timezone alone. */
export function viewportFromTimezone(zone: string | undefined): Viewport {
  if (!zone) return WORLD;
  const city = ZONE_CENTERS[zone];
  if (city) return { lng: city[0], lat: city[1], zoom: CITY_ZOOM };
  const region = REGION_CENTERS[zone.split("/")[0] ?? ""];
  if (region) return { lng: region[0], lat: region[1], zoom: REGION_ZOOM };
  return WORLD;
}
