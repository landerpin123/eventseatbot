import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../auth/auth.middleware';
import { bookings } from '../storage/booking.storage';

const router = Router();

/**
 * Active bookings (reserved, not expired)
 */
router.get('/bookings', authMiddleware, (req: AuthRequest, res) => {
  const user = req.user;
  if (!user || typeof user.id === 'undefined') return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(user.id);
  const now = Date.now();

  const userBookings = bookings.filter(
    (b) => b.userId === userId && b.status === 'reserved' && b.expiresAt > now,
  );

  res.json(userBookings);
});

/**
 * Purchased tickets (confirmed)
 */
router.get('/tickets', authMiddleware, (req: AuthRequest, res) => {
  const user = req.user;
  if (!user || typeof user.id === 'undefined') return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(user.id);

  const tickets = bookings.filter((b) => b.userId === userId && b.status === 'confirmed');

  res.json(tickets);
});

export default router;
