import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../auth/auth.middleware';
import { adminOnly } from '../auth/admin.middleware';

// Seat shape
export interface Seat {
  id: string;
  eventId: string;
  row: string | number;
  number: number;
  price: number;
  status: string; // default: 'available'
}

const router = Router();

// In-memory storage for seats (volatile)
export const seats: Seat[] = [];

// Protect all admin seat routes
router.use(authMiddleware, adminOnly);

const validateSeatInput = (s: unknown) => {
  const errs: string[] = [];
  if (!s || typeof s !== 'object') return ['invalid seat object'];
  const seat = s as Record<string, unknown>;
  if (!seat.eventId || typeof seat.eventId !== 'string') errs.push('eventId is required');
  if (typeof seat.row === 'undefined' || (typeof seat.row !== 'string' && typeof seat.row !== 'number')) errs.push('row is required');
  if (typeof seat.number !== 'number' || Number.isNaN(seat.number as number)) errs.push('number must be a number');
  if (typeof seat.price !== 'number' || Number.isNaN(seat.price as number)) errs.push('price must be a number');
  return errs;
};

// POST /admin/seats - create single or multiple seats
router.post('/seats', (req: Request, res: Response) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : [body];

  const created: Seat[] = [];
  const errors: { index: number; errors: string[] }[] = [];

  items.forEach((it, idx) => {
    const errs = validateSeatInput(it);
    if (errs.length) {
      errors.push({ index: idx, errors: errs });
      return;
    }

    const seat: Seat = {
      id: typeof it.id === 'string' && it.id.length ? it.id : uuid(),
      eventId: it.eventId,
      row: it.row,
      number: it.number,
      price: it.price,
      status: typeof it.status === 'string' && it.status.length ? it.status : 'available',
    };

    seats.push(seat);
    created.push(seat);
  });

  if (errors.length) return res.status(400).json({ errors });
  res.status(201).json(created.length === 1 ? created[0] : created);
});

// GET /admin/seats?eventId=...
router.get('/seats', (req: Request, res: Response) => {
  const eventId = req.query.eventId as string | undefined;
  if (eventId) {
    return res.json(seats.filter((s) => s.eventId === eventId));
  }
  res.json(seats);
});

export default router;
