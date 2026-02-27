import { Router } from "express";

const router = Router();

router.post("/", (req, res) => {
  const { userId, items } = req.body;
  // TODO: create order and initiate dispatch flow
  return res.status(201).json({
    id: "ord_123",
    userId,
    items,
    status: "pending",
  });
});

router.get("/:orderId", (req, res) => {
  const { orderId } = req.params;
  // TODO: load order and tracking info
  return res.json({
    id: orderId,
    status: "in_transit",
    etaMinutes: 25,
  });
});

export default router;

