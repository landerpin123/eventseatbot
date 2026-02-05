import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { authMiddleware } from '../auth/auth.middleware';
import { adminOnly } from '../auth/admin.middleware';
import { getEvents, saveEvents, upsertEvent, findEventById } from '../db';
import type { EventData } from '../models';

// Simple Event shape for admin CRUD
export interface Event {
  id: string;
  title: string;
  description: string;
  date: string; // ISO date
}

const router = Router();

// Protect all admin event routes
router.use(authMiddleware, adminOnly);

const validate = (body: unknown) => {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    errors.push('Invalid body');
    return errors;
  }
  const b = body as Record<string, unknown>;
  if (!b.title || typeof b.title !== 'string') errors.push('title is required');
  if (!b.description || typeof b.description !== 'string') errors.push('description is required');
  if (!b.date || typeof b.date !== 'string' || Number.isNaN(Date.parse(b.date as string))) errors.push('date is required (ISO string)');
  return errors;
};

const toEvent = (e: EventData): Event => ({ id: e.id, title: e.title, description: e.description, date: e.date });

// GET /admin/events
router.get('/events', (_req: Request, res: Response) => {
  const events = getEvents().map(toEvent);
  res.json(events);
});

// POST /admin/events
router.post('/events', (req: Request, res: Response) => {
  const errs = validate(req.body);
  if (errs.length) return res.status(400).json({ errors: errs });

  const id = uuid();
  const newEvent: Event = { id, title: req.body.title, description: req.body.description, date: req.body.date };

  // Convert to EventData with sensible defaults so storage remains compatible
  const eventData: EventData = {
    id: newEvent.id,
    title: newEvent.title,
    description: newEvent.description,
    date: newEvent.date,
    imageUrl: req.body.imageUrl || '',
    paymentPhone: req.body.paymentPhone || '',
    maxSeatsPerBooking: Number(req.body.maxSeatsPerBooking) || 0,
    tables: req.body.tables || [],
  };

  upsertEvent(eventData);
  res.status(201).json(newEvent);
});

// PUT /admin/events/:id
router.put('/events/:id', (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!id) {
    return res.status(400).json({ error: 'Event id is required' });
  }
  const existing = findEventById(id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });

  const errs = validate(req.body);
  if (errs.length) return res.status(400).json({ errors: errs });

  existing.title = req.body.title;
  existing.description = req.body.description;
  existing.date = req.body.date;
  // allow optional other fields to be updated if provided
  if (typeof req.body.imageUrl === 'string') existing.imageUrl = req.body.imageUrl;
  if (typeof req.body.paymentPhone === 'string') existing.paymentPhone = req.body.paymentPhone;
  if (typeof req.body.maxSeatsPerBooking !== 'undefined') existing.maxSeatsPerBooking = Number(req.body.maxSeatsPerBooking) || 0;
  if (Array.isArray(req.body.tables)) existing.tables = req.body.tables;

  upsertEvent(existing);
  res.json(toEvent(existing));
});

// DELETE /admin/events/:id
router.delete('/events/:id', (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const events = getEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  events.splice(idx, 1);
  saveEvents(events);
  res.json({ ok: true });
});

export default router;
