import { Router } from "express";

const router = Router();

router.get("/search", (req, res) => {
  const { query, role } = req.query;
  // TODO: connect to DB and search parts
  return res.json({
    query,
    role,
    results: [],
  });
});

router.post("/requests", (req, res) => {
  const { userId, vehicle, partDescription, urgency } = req.body;
  // TODO: persist request and notify vendors
  return res.status(201).json({
    id: "req_123",
    userId,
    vehicle,
    partDescription,
    urgency,
    status: "open",
  });
});

export default router;

