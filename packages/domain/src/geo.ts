/** Haversine distance in meters. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Approximate bbox area in km² — used for viewport-query budgets. */
export function bboxAreaKm2(bbox: BBox): number {
  const midLat = (bbox.north + bbox.south) / 2;
  const heightKm = distanceMeters(bbox.south, bbox.west, bbox.north, bbox.west) / 1000;
  const widthKm = distanceMeters(midLat, bbox.west, midLat, bbox.east) / 1000;
  return heightKm * widthKm;
}
