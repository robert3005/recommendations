import { MAP_STYLE_URL } from "../../config";
import { MapView } from "../../map/MapView";

export function MapPage() {
  return (
    <div className="relative h-full" data-testid="map-page">
      <MapView styleUrl={MAP_STYLE_URL} savedPins={[]} poiPins={[]} />
    </div>
  );
}
