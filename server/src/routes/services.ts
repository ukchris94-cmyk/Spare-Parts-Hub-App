import { Request, Response, Router } from "express";

const router = Router();

type TowingPriority = "standard" | "urgent";
type VehicleType = "sedan" | "suv" | "truck" | "van";

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function toCurrencyNGN(value: number): string {
  return `₦${Math.round(value).toLocaleString()}`;
}

router.get("/catalog", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    services: {
      towing: [
        "Emergency tow",
        "Remote-area recovery",
        "Battery boost and minor roadside help",
      ],
      mechanic: [
        "On-site inspection",
        "Brake service",
        "Engine diagnostics",
        "Suspension repairs",
      ],
    },
  });
});

router.post("/towing/quote", (req: Request, res: Response) => {
  const {
    distanceKm,
    priority = "standard",
    vehicleType = "sedan",
    isRemote = false,
  } = req.body as {
    distanceKm?: number | string;
    priority?: TowingPriority;
    vehicleType?: VehicleType;
    isRemote?: boolean;
  };

  const km = parsePositiveNumber(distanceKm);
  if (km === null) {
    return res.status(400).json({
      ok: false,
      message: "distanceKm is required and must be a positive number",
    });
  }

  const baseFee = 12000;
  const perKm = 1300;
  const remoteFee = isRemote ? 8500 : 0;
  const urgentFee = priority === "urgent" ? 6000 : 0;
  const vehicleMultiplier =
    vehicleType === "truck" ? 1.35 : vehicleType === "van" ? 1.2 : vehicleType === "suv" ? 1.1 : 1;

  const subtotal = (baseFee + km * perKm + remoteFee + urgentFee) * vehicleMultiplier;
  const etaMinutes = Math.max(35, Math.round(25 + km * 2 + (isRemote ? 20 : 0)));

  return res.json({
    ok: true,
    service: "towing",
    quote: {
      distanceKm: km,
      priority,
      vehicleType,
      isRemote,
      etaMinutes,
      total: Math.round(subtotal),
      totalFormatted: toCurrencyNGN(subtotal),
      breakdown: {
        baseFee,
        distanceFee: Math.round(km * perKm),
        remoteFee,
        urgentFee,
        vehicleMultiplier,
      },
    },
  });
});

router.post("/mechanic/quote", (req: Request, res: Response) => {
  const {
    serviceType = "general-repair",
    laborHours = 1,
    partsCost = 0,
    isRemote = false,
    complexity = "medium",
  } = req.body as {
    serviceType?: string;
    laborHours?: number | string;
    partsCost?: number | string;
    isRemote?: boolean;
    complexity?: "low" | "medium" | "high";
  };

  const hours = parsePositiveNumber(laborHours);
  const parts = parsePositiveNumber(partsCost);
  if (hours === null || hours <= 0) {
    return res.status(400).json({
      ok: false,
      message: "laborHours is required and must be greater than 0",
    });
  }
  if (parts === null) {
    return res.status(400).json({
      ok: false,
      message: "partsCost must be a positive number",
    });
  }

  const ratePerHour =
    complexity === "high" ? 22000 : complexity === "low" ? 12000 : 16000;
  const remoteCallout = isRemote ? 7000 : 0;
  const laborTotal = Math.round(hours * ratePerHour);
  const subtotal = laborTotal + parts + remoteCallout;

  return res.json({
    ok: true,
    service: "mechanic",
    quote: {
      serviceType,
      laborHours: hours,
      complexity,
      isRemote,
      partsCost: Math.round(parts),
      laborRatePerHour: ratePerHour,
      total: Math.round(subtotal),
      totalFormatted: toCurrencyNGN(subtotal),
      pricing: {
        laborTotal,
        parts: Math.round(parts),
        remoteCallout,
      },
    },
  });
});

export default router;
