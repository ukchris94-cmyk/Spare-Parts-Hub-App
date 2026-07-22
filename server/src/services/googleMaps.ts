import { randomUUID } from "crypto";
import { decode } from "@googlemaps/polyline-codec";

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type PlaceAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
  languageCode?: string;
};

export type ResolvedPlace = Coordinates & {
  formattedAddress: string;
  placeId: string | null;
  addressComponents: PlaceAddressComponent[];
};

export type PlaceSuggestion = {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
};

export type DeliveryRoutePhase = "to_pickup" | "to_dropoff";

export type DeliveryRoute = {
  phase: DeliveryRoutePhase;
  coordinates: Coordinates[];
  distanceMeters: number;
  durationSeconds: number;
  calculatedAt: string;
  expiresAt: string;
  origin: Coordinates;
  destination: Coordinates;
};

type RouteCacheEntry = DeliveryRoute & {
  calculatedAtMs: number;
};

type GoogleErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export class GoogleMapsServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly code = "GOOGLE_MAPS_REQUEST_FAILED"
  ) {
    super(message);
    this.name = "GoogleMapsServiceError";
  }
}

const routeCache = new Map<string, RouteCacheEntry>();
const inFlightRoutes = new Map<string, Promise<DeliveryRoute>>();

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getServerApiKey(): string {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  if (!key) {
    throw new GoogleMapsServiceError(
      "Google Maps server integration is not configured",
      503,
      "GOOGLE_MAPS_NOT_CONFIGURED"
    );
  }
  return key;
}

function getCountryCode(): string {
  return (process.env.GOOGLE_MAPS_COUNTRY_CODE || "ng").trim().toLowerCase();
}

function isCoordinates(value: Coordinates): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

async function googleFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const timeoutMs = readPositiveNumber("GOOGLE_MAPS_REQUEST_TIMEOUT_MS", 8000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as GoogleErrorBody | null;
      const providerMessage = payload?.error?.message;
      throw new GoogleMapsServiceError(
        providerMessage || "Google Maps request failed",
        response.status === 429 ? 429 : 502,
        response.status === 429 ? "GOOGLE_MAPS_RATE_LIMITED" : "GOOGLE_MAPS_REQUEST_FAILED"
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof GoogleMapsServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GoogleMapsServiceError(
        "Google Maps request timed out",
        504,
        "GOOGLE_MAPS_TIMEOUT"
      );
    }
    throw new GoogleMapsServiceError("Google Maps service is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export async function autocompletePlaces(
  input: string,
  sessionToken?: string
): Promise<{ sessionToken: string; suggestions: PlaceSuggestion[] }> {
  const token = sessionToken?.trim() || randomUUID();
  const countryCode = getCountryCode();
  const payload = await googleFetch<{
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
      };
    }>;
  }>("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getServerApiKey(),
      "X-Goog-FieldMask":
        "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
    },
    body: JSON.stringify({
      input,
      includedRegionCodes: [countryCode],
      regionCode: countryCode.toUpperCase(),
      languageCode: "en",
      sessionToken: token,
    }),
  });

  const suggestions = (payload.suggestions || []).flatMap((item) => {
    const prediction = item.placePrediction;
    if (!prediction?.placeId || !prediction.text?.text) return [];
    return [
      {
        placeId: prediction.placeId,
        text: prediction.text.text,
        mainText: prediction.structuredFormat?.mainText?.text || prediction.text.text,
        secondaryText: prediction.structuredFormat?.secondaryText?.text || "",
      },
    ];
  });

  return { sessionToken: token, suggestions };
}

export async function resolvePlace(
  placeId: string,
  sessionToken?: string
): Promise<ResolvedPlace> {
  const countryCode = getCountryCode();
  const params = new URLSearchParams({
    languageCode: "en",
    regionCode: countryCode.toUpperCase(),
  });
  if (sessionToken?.trim()) params.set("sessionToken", sessionToken.trim());

  const payload = await googleFetch<{
    id?: string;
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    addressComponents?: PlaceAddressComponent[];
  }>(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${params}`, {
    headers: {
      "X-Goog-Api-Key": getServerApiKey(),
      "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents",
    },
  });

  const resolved = {
    formattedAddress: payload.formattedAddress || "",
    latitude: Number(payload.location?.latitude),
    longitude: Number(payload.location?.longitude),
    placeId: payload.id || placeId,
    addressComponents: Array.isArray(payload.addressComponents) ? payload.addressComponents : [],
  };
  if (!resolved.formattedAddress || !isCoordinates(resolved)) {
    throw new GoogleMapsServiceError(
      "The selected address could not be mapped",
      422,
      "PLACE_NOT_MAPPABLE"
    );
  }
  return resolved;
}

export async function reverseGeocode(coordinates: Coordinates): Promise<ResolvedPlace> {
  if (!isCoordinates(coordinates)) {
    throw new GoogleMapsServiceError("Invalid coordinates", 400, "INVALID_COORDINATES");
  }
  const params = new URLSearchParams({
    latlng: `${coordinates.latitude},${coordinates.longitude}`,
    key: getServerApiKey(),
    region: getCountryCode(),
    language: "en",
  });
  const payload = await googleFetch<{
    status?: string;
    results?: Array<{
      formatted_address?: string;
      place_id?: string;
      address_components?: Array<{
        long_name?: string;
        short_name?: string;
        types?: string[];
      }>;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  }>(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);

  const first = payload.results?.[0];
  const result = {
    formattedAddress: first?.formatted_address || "",
    latitude: Number(first?.geometry?.location?.lat ?? coordinates.latitude),
    longitude: Number(first?.geometry?.location?.lng ?? coordinates.longitude),
    placeId: first?.place_id || null,
    addressComponents: (first?.address_components || []).map((component) => ({
      longText: component.long_name,
      shortText: component.short_name,
      types: component.types,
    })),
  };
  if (!result.formattedAddress || !isCoordinates(result)) {
    throw new GoogleMapsServiceError(
      "No mapped address was found for this location",
      422,
      "ADDRESS_NOT_FOUND"
    );
  }
  return result;
}

export async function geocodeAddress(address: string): Promise<ResolvedPlace> {
  const normalizedAddress = address.trim();
  if (normalizedAddress.length < 8 || normalizedAddress.length > 300) {
    throw new GoogleMapsServiceError("A valid address is required", 400, "INVALID_ADDRESS");
  }
  const countryCode = getCountryCode();
  const params = new URLSearchParams({
    address: normalizedAddress,
    key: getServerApiKey(),
    region: countryCode,
    language: "en",
    components: `country:${countryCode.toUpperCase()}`,
  });
  const payload = await googleFetch<{
    results?: Array<{
      formatted_address?: string;
      place_id?: string;
      address_components?: Array<{
        long_name?: string;
        short_name?: string;
        types?: string[];
      }>;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  }>(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  const first = payload.results?.[0];
  const result = {
    formattedAddress: first?.formatted_address || "",
    latitude: Number(first?.geometry?.location?.lat),
    longitude: Number(first?.geometry?.location?.lng),
    placeId: first?.place_id || null,
    addressComponents: (first?.address_components || []).map((component) => ({
      longText: component.long_name,
      shortText: component.short_name,
      types: component.types,
    })),
  };
  if (!result.formattedAddress || !isCoordinates(result)) {
    throw new GoogleMapsServiceError(
      "No mapped location was found for this address",
      422,
      "ADDRESS_NOT_FOUND"
    );
  }
  return result;
}

function haversineMeters(first: Coordinates, second: Coordinates): number {
  const radius = 6371000;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latDistance = radians(second.latitude - first.latitude);
  const lngDistance = radians(second.longitude - first.longitude);
  const a =
    Math.sin(latDistance / 2) ** 2 +
    Math.cos(radians(first.latitude)) *
      Math.cos(radians(second.latitude)) *
      Math.sin(lngDistance / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function shouldReuseRoute(
  cached: RouteCacheEntry | undefined,
  phase: DeliveryRoutePhase,
  origin: Coordinates,
  destination: Coordinates,
  now: number
): boolean {
  if (!cached || cached.phase !== phase) return false;
  if (haversineMeters(cached.destination, destination) > 25) return false;

  const ageMs = now - cached.calculatedAtMs;
  const cacheMs = readPositiveNumber("GOOGLE_ROUTES_CACHE_SECONDS", 300) * 1000;
  if (ageMs >= cacheMs) return false;

  const minimumRefreshMs =
    readPositiveNumber("GOOGLE_ROUTES_MIN_REFRESH_SECONDS", 120) * 1000;
  const minimumMovementMeters = readPositiveNumber(
    "GOOGLE_ROUTES_MIN_MOVEMENT_METERS",
    1000
  );
  return !(
    ageMs >= minimumRefreshMs &&
    haversineMeters(cached.origin, origin) >= minimumMovementMeters
  );
}

async function requestRoute(
  phase: DeliveryRoutePhase,
  origin: Coordinates,
  destination: Coordinates
): Promise<DeliveryRoute> {
  if (!isCoordinates(origin) || !isCoordinates(destination)) {
    throw new GoogleMapsServiceError("Invalid route coordinates", 400, "INVALID_COORDINATES");
  }
  const payload = await googleFetch<{
    routes?: Array<{
      duration?: string;
      distanceMeters?: number;
      polyline?: { encodedPolyline?: string };
    }>;
  }>("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getServerApiKey(),
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: {
        location: {
          latLng: { latitude: origin.latitude, longitude: origin.longitude },
        },
      },
      destination: {
        location: {
          latLng: { latitude: destination.latitude, longitude: destination.longitude },
        },
      },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      polylineQuality: "OVERVIEW",
      polylineEncoding: "ENCODED_POLYLINE",
      computeAlternativeRoutes: false,
      languageCode: "en-US",
      units: "METRIC",
    }),
  });

  const route = payload.routes?.[0];
  const encodedPolyline = route?.polyline?.encodedPolyline;
  if (!route || !encodedPolyline) {
    throw new GoogleMapsServiceError(
      "No road route was found for this delivery",
      422,
      "ROUTE_NOT_FOUND"
    );
  }
  const durationSeconds = Math.max(0, Number.parseFloat(route.duration || "0s") || 0);
  const calculatedAtMs = Date.now();
  const cacheSeconds = readPositiveNumber("GOOGLE_ROUTES_CACHE_SECONDS", 300);
  return {
    phase,
    coordinates: decode(encodedPolyline).map(([latitude, longitude]) => ({
      latitude,
      longitude,
    })),
    distanceMeters: Math.max(0, Number(route.distanceMeters) || 0),
    durationSeconds,
    calculatedAt: new Date(calculatedAtMs).toISOString(),
    expiresAt: new Date(calculatedAtMs + cacheSeconds * 1000).toISOString(),
    origin,
    destination,
  };
}

export async function getCachedDeliveryRoute(input: {
  deliveryJobId: string;
  phase: DeliveryRoutePhase;
  origin: Coordinates;
  destination: Coordinates;
}): Promise<DeliveryRoute> {
  const now = Date.now();
  for (const [deliveryJobId, entry] of routeCache.entries()) {
    if (now - entry.calculatedAtMs > 60 * 60 * 1000) routeCache.delete(deliveryJobId);
  }
  const cached = routeCache.get(input.deliveryJobId);
  if (cached && shouldReuseRoute(cached, input.phase, input.origin, input.destination, now)) {
    return cached;
  }

  const existingRequest = inFlightRoutes.get(input.deliveryJobId);
  if (existingRequest) return existingRequest;

  const request = requestRoute(input.phase, input.origin, input.destination)
    .then((route) => {
      routeCache.set(input.deliveryJobId, {
        ...route,
        calculatedAtMs: Date.parse(route.calculatedAt),
      });
      return route;
    })
    .finally(() => {
      inFlightRoutes.delete(input.deliveryJobId);
    });
  inFlightRoutes.set(input.deliveryJobId, request);
  return request;
}

export function clearDeliveryRouteCache(deliveryJobId: string): void {
  routeCache.delete(deliveryJobId);
  inFlightRoutes.delete(deliveryJobId);
}
