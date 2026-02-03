import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { v4 as uuid } from 'uuid';
import type { Booking, EventData } from './models';
import {
  getEvents,
  findEventById,
  saveEvents,
  getBookings,
  addBooking,
  updateBookingStatus,
} from './db';
import { initBot, notifyAdminsAboutBooking, notifyUser } from './bot';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());

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

// Events
app.get('/events', (_req, res) => {
  res.json(getEvents());
});

app.get('/events/:eventId', (req, res) => {
  const event = findEventById(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

// Create booking
app.post('/bookings', (req, res) => {
  const { eventId, telegramUserId, username, seatIds } = req.body as {
    eventId: string;
    telegramUserId: number;
    username: string;
    seatIds: string[];
  };

  const event = findEventById(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'No seats selected' });
  }

  // Check seat availability and compute total
  let totalAmount = 0;
  const now = Date.now();
  for (const fullId of seatIds) {
    const [tableId, seatId] = fullId.split('-');
    const table = event.tables.find((t) => t.id === tableId);
    const seat = table?.seats.find((s) => s.id === seatId);
    if (!seat) return res.status(400).json({ error: `Seat not found: ${fullId}` });
    if (seat.status !== 'free') {
      return res.status(400).json({ error: `Seat not available: ${fullId}` });
    }
    totalAmount += seat.price;
    seat.status = 'locked';
    seat.lockedAt = now;
    seat.bookedBy = username;
  }

  const booking: Booking = {
    id: uuid(),
    eventId,
    userTelegramId: Number(telegramUserId),
    username: username ?? '',
    seatIds,
    totalAmount,
    status: 'pending',
    createdAt: now,
  };

  addBooking(booking);
  // persist updated event with locked seats
  const events = getEvents().map((e) => (e.id === event.id ? event : e));
  saveEvents(events);

  // Notify user and admins via bot (best-effort)
  notifyUser(
    telegramUserId,
    `Вы выбрали места ${seatIds.join(
      ', ',
    )}. К оплате ${totalAmount} рублей. Перевод по номеру тел. ${event.paymentPhone} СБП. После оплаты ожидайте билеты в этом чате.`,
  );

  notifyAdminsAboutBooking(
    `@${username} забронировал места ${seatIds.join(
      ', ',
    )} на мероприятие "${event.title}" на сумму ${totalAmount} ₽. Проверьте оплату.`,
  );

  res.status(201).json(booking);
});

// My bookings
app.get('/bookings/my', (req, res) => {
  const telegramUserId = Number(req.query.telegramUserId);
  if (!telegramUserId) return res.status(400).json({ error: 'telegramUserId is required' });
  const all = getBookings();
  const mine = all.filter((b) => b.userTelegramId === telegramUserId);
  res.json(mine);
});

// Admin endpoints
app.get('/admin/bookings', (req, res) => {
  const status = req.query.status as string | undefined;
  let all = getBookings();
  if (status) {
    all = all.filter((b) => b.status === status);
  }
  res.json(all);
});

app.post('/admin/bookings/:id/confirm', (req, res) => {
  const booking = updateBookingStatus(req.params.id, 'paid');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const event = findEventById(booking.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Mark seats as sold
  for (const fullId of booking.seatIds) {
    const [tableId, seatId] = fullId.split('-');
    const table = event.tables.find((t) => t.id === tableId);
    const seat = table?.seats.find((s) => s.id === seatId);
    if (seat) {
      seat.status = 'sold';
      if (seat.lockedAt !== undefined) {
        delete seat.lockedAt;
      }
    }
  }

  const events = getEvents().map((e) => (e.id === event.id ? event : e));
  saveEvents(events);

  // In a real setup, here we would iterate seats and send ticket images based on ticketImagePath
  notifyUser(
    booking.userTelegramId,
    'Оплата подтверждена. В ближайшее время вы получите билеты (графические файлы).',
  );

  res.json({ ok: true });
});

// Cleanup expired locks every minute
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
          if (seat.lockedAt !== undefined) {
            delete seat.lockedAt;
          }
          if (seat.bookedBy !== undefined) {
            delete seat.bookedBy;
          }
          changed = true;
        }
      }
    }
  }
  if (changed) {
    saveEvents(events);
  }
}, 60_000);

app.listen(PORT, () => {
  console.log(`Backend API listening on http://localhost:${PORT}`);
});

