import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { v4 as uuid } from 'uuid';
import type { EventData } from './models';
import { getEvents, findEventById, saveEvents, getBookings } from './db';
import { bot, notifyAdminsAboutBooking, notifyUser } from './bot';
import adminEventsRouter from './routes/adminEvents';
import adminSeatsRouter, { seats as inMemorySeats } from './routes/adminSeats';
import adminBookingsRouter from './routes/adminBookings';
import { inMemoryBookings } from './state';
import { authMiddleware, AuthRequest } from './auth/auth.middleware';
import 'dotenv/config';
import authRoutes from './auth/auth.routes';
import { startBookingExpirationJob } from './jobs/bookingExpiration.job';
import meRoutes from './routes/me.routes';


const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());
app.use('/auth', authRoutes);
app.use('/me', meRoutes);

/**
 * ==============================
 * TELEGRAM WEBHOOK ENDPOINT
 * ==============================
 * Telegram будет слать POST сюда
 */
app.post('/telegram/webhook', (req, res) => {
  if (bot) {
    bot.handleUpdate(req.body);
  }
  res.sendStatus(200);
});

// Seed from frontend mock if no events exist (simple dev helper)
const seedIfEmpty = () => {
  const events = getEvents();
  if (events.length === 0) {
    const mock: EventData = {
      id: 'evt-1',
      title: 'Gala Dinner 2024',
      description: 'An exclusive evening of fine dining and networking.',
      date: '2024-12-25',
      imageUrl: 'https://picsum.photos/800/600',
      paymentPhone: '79991234567',
      maxSeatsPerBooking: 4,
      tables: [],
    };
    saveEvents([mock]);
  }
};

seedIfEmpty();

// ==============================
// EVENTS
// ==============================
app.get('/events', (_req, res) => {
  res.json(getEvents());
});

app.get('/events/:eventId', (req, res) => {
  const event = findEventById(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// ==============================
// CREATE BOOKING (user-facing)
// ==============================
app.post('/bookings', authMiddleware, (req: AuthRequest, res) => {
  const user = req.user;
  const userIdVal = user?.id ?? user?.sub ?? user?.userId;
  if (!userIdVal) return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(userIdVal);

  const { eventId, seatIds } = req.body as { eventId: string; seatIds: string[] };
  if (!eventId || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'eventId and seatIds[] are required' });
  }

  // Validate event exists
  const event = findEventById(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Check seats exist and are available
  const seatsToReserve: any[] = [];
  for (const seatId of seatIds) {
    const s = inMemorySeats.find((x) => x.id === seatId && x.eventId === eventId);
    if (!s) return res.status(400).json({ error: `Seat not found: ${seatId}` });
    if (s.status !== 'available') return res.status(400).json({ error: `Seat not available: ${seatId}` });
    seatsToReserve.push(s);
  }

  // Calculate total
  const totalPrice = seatsToReserve.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000;

  // Reserve seats
  for (const s of seatsToReserve) {
    s.status = 'reserved';
  }

  const booking: import('./state').InMemoryBooking = {
    id: uuid(),
    eventId,
    userId,
    seatIds,
    totalPrice,
    status: 'reserved',
    createdAt: now,
    expiresAt,
  };

  inMemoryBookings.push(booking);

  // Expire reservation after 15 minutes if still reserved
  setTimeout(() => {
    const b = inMemoryBookings.find((x) => x.id === booking.id);
    if (!b) return;
    if (b.status === 'reserved') {
      for (const sid of b.seatIds) {
        const s = inMemorySeats.find((x) => x.id === sid && x.eventId === b.eventId);
        if (s && s.status === 'reserved') s.status = 'available';
      }
      b.status = 'cancelled';
    }
  }, expiresAt - now);

  const paymentInstructions = event
    ? `Pay ${totalPrice} ₽ to ${event.paymentPhone || 'the provided payment method'}`
    : `Pay ${totalPrice} ₽`;

  res.status(201).json({ booking, paymentInstructions });
});

// ==============================
// MY BOOKINGS
// ==============================
app.get('/bookings/my', (req, res) => {
  const telegramUserId = Number(req.query.telegramUserId);
  if (!telegramUserId) {
    return res.status(400).json({ error: 'telegramUserId is required' });
  }
  const all = getBookings();
  const mine = all.filter((b) => b.userTelegramId === telegramUserId);
  res.json(mine);
});


// Mount admin routes (JWT + adminOnly applied inside router)
app.use('/admin', adminEventsRouter);
app.use('/admin', adminSeatsRouter);
app.use('/admin', adminBookingsRouter);

// ==============================
// CLEANUP LOCKS
// ==============================
const LOCK_DURATION = 15 * 60 * 1000;
setInterval(() => {
  const events = getEvents();
  const now = Date.now();
  let changed = false;

  for (const event of events) {
    for (const table of event.tables) {
      for (const seat of table.seats) {
        if (seat.status === 'locked' && seat.lockedAt && now - seat.lockedAt > LOCK_DURATION) {
          seat.status = 'free';
          delete seat.lockedAt;
          delete seat.bookedBy;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveEvents(events);
  }
}, 60_000);

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`Backend API listening on http://localhost:${PORT}`);
  startBookingExpirationJob();
});
