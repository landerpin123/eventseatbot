import { Router, Request, Response } from 'express';
import { authMiddleware } from '../auth/auth.middleware';
import { adminOnly } from '../auth/admin.middleware';
import { inMemoryBookings } from '../state';
import { seats as inMemorySeats } from './adminSeats';

const router = Router();

router.use(authMiddleware, adminOnly);

// GET /admin/bookings
router.get('/bookings', (_req: Request, res: Response) => {
  res.json(inMemoryBookings);
});

// POST /admin/bookings/:id/confirm
router.post('/bookings/:id/confirm', (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const booking = inMemoryBookings.find((b) => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'reserved') return res.status(400).json({ error: 'Only reserved bookings can be confirmed' });
  const now = Date.now();
  if (now > booking.expiresAt) return res.status(400).json({ error: 'Booking expired' });

  // mark booking confirmed
  booking.status = 'confirmed';

  // mark seats sold
  for (const sid of booking.seatIds) {
    const s = inMemorySeats.find((x) => x.id === sid && x.eventId === booking.eventId);
    if (s) s.status = 'sold';
  }

  res.json({ ok: true, booking });
});

export default router;
