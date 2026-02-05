import React, { useState, useEffect } from 'react';
import { EventData, Booking, ViewState } from './types';
import * as StorageService from './services/storageService';
import AuthService from './services/authService';
import SeatMap from './components/SeatMap';
import AdminPanel from './components/AdminPanel';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initDataUnsafe?: {
          user?: {
            id?: number;
            username?: string;
          };
        };
      };
    };
  }
}

function App() {
  const [view, setView] = useState<ViewState>('event-list');
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUsername, setCurrentUsername] = useState<string>('guest');
  const [telegramUserId, setTelegramUserId] = useState<number | null>(null);
  const [tgReady, setTgReady] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const [events, setEvents] = useState<EventData[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventData | null>(null);
  
  // Selection State
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]); // "tableId-seatId"
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]); // actual seat.id values for backend
  const [selectionTotal, setSelectionTotal] = useState(0);
  // Authentication finite state machine
  const [authState, setAuthState] = useState<'init' | 'authenticating' | 'ready' | 'error'>('init');
  const [authError, setAuthError] = useState<string | null>(null);

  // Show loading when initializing or authenticating
  if (authState === 'init' || authState === 'authenticating') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="max-w-md bg-white p-6 rounded shadow text-center">
          <h2 className="text-lg font-semibold mb-3">Loading…</h2>
          <p className="text-sm text-gray-600">Initializing Telegram Web App integration.</p>
        </div>
      </div>
    );
  }

  // Show blocking error when authState === 'error'
  if (authState === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="max-w-md bg-white p-6 rounded shadow text-center">
          <h2 className="text-lg font-semibold mb-3">Error</h2>
          <p className="text-sm text-gray-600">{authError || 'Authentication failed. Please reopen the Web App from Telegram.'}</p>
        </div>
      </div>
    );
  }

  // Poll for Telegram.WebApp presence (short timeout). Presence alone starts auth.
  useEffect(() => {
    let mounted = true;
    const checkInterval = 100;
    let elapsed = 0;
    const timeoutMs = 1500;

    const poll = setInterval(() => {
      try {
        if ((window as any).Telegram && (window as any).Telegram.WebApp) {
          if (mounted) setAuthState('authenticating');
          clearInterval(poll);
          return;
        }
      } catch {}
      elapsed += checkInterval;
      if (elapsed >= timeoutMs) {
        clearInterval(poll);
        if (mounted) {
          setAuthState('error');
          setAuthError('This Web App must be opened from the Telegram client.');
        }
      }
    }, checkInterval);

    // immediate check
    try {
      if ((window as any).Telegram && (window as any).Telegram.WebApp) {
        if (mounted) setAuthState('authenticating');
        clearInterval(poll);
      }
    } catch {}

    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, []);

  // When Telegram WebApp is ready, call ready() and attempt to read init data (no polling for user)
  useEffect(() => {
    if (authState !== 'authenticating') return;
    const tg = (window as any).Telegram?.WebApp;
    if (!tg) {
      setAuthState('error');
      setAuthError('Telegram WebApp is not available.');
      return;
    }

    const safeReady = () => {
      try {
        tg.ready?.();
      } catch {}
    };

    const extractTelegramUser = (): { id: number; username?: string } | null => {
      try {
        const unsafe = (tg as any).initDataUnsafe as { user?: { id?: number; username?: string } } | undefined;
        if (unsafe?.user && typeof unsafe.user.id !== 'undefined') {
          return { id: Number(unsafe.user.id), username: unsafe.user.username };
        }

        const initDataStr = (tg as any).initData as string | undefined;
        if (typeof initDataStr === 'string' && initDataStr.length) {
          try {
            const params = new URLSearchParams(initDataStr);
            const userParam = params.get('user');
            if (userParam) {
              try {
                const u = JSON.parse(userParam);
                if (u && typeof u.id !== 'undefined') return { id: Number(u.id), username: u.username };
              } catch {}
            }
            const uid = params.get('user_id') || params.get('userId') || params.get('id');
            const uname = params.get('username') || params.get('user_name');
            if (uid) return { id: Number(uid), username: uname || undefined };
          } catch {}
        }
      } catch {}
      return null;
    };

    safeReady();

    const resolved = extractTelegramUser();
    if (!resolved) {
      // Do not poll indefinitely; if user id cannot be determined, move to error state.
      setAuthState('error');
      setAuthError('Unable to obtain Telegram user id from the client. Please reopen the Web App from Telegram.');
      return;
    }

    setTelegramUserId(resolved.id);
    setCurrentUsername(resolved.username || `user_${resolved.id}`);
    AuthService.loginWithTelegram(resolved.id)
      .then(() => {
        const token = AuthService.getToken();
        const payload = AuthService.decodeToken(token);
        setIsAdmin((payload as any)?.role === 'admin');
        setTgReady(true);
        setAuthState('ready');
      })
      .catch((err) => {
        setAuthState('error');
        setAuthError((err as Error)?.message || 'Authentication failed');
      });

    const onAuthChanged = () => {
      const t = AuthService.getToken();
      if (!t) return setIsAdmin(false);
      const p = AuthService.decodeToken(t);
      setIsAdmin((p as any)?.role === 'admin');
    };

    window.addEventListener('auth:changed', onAuthChanged as EventListener);
    return () => window.removeEventListener('auth:changed', onAuthChanged as EventListener);
  }, [authState]);

  // Viewport and back-button integration when Telegram is ready
  useEffect(() => {
    if (telegramStatus !== 'ready') return;
    const tg = (window as any).Telegram?.WebApp;
    if (!tg) return;

    const updateViewport = () => {
      try {
        const h = (tg as any).viewportHeight;
        if (typeof h === 'number') {
          document.documentElement.style.setProperty('--tg-viewport-height', `${h}px`);
        }
      } catch {}
    };

    updateViewport();

    const hasOnEvent = typeof (tg as any).onEvent === 'function';
    if (hasOnEvent) {
      try {
        (tg as any).onEvent('viewportChanged', updateViewport);
        (tg as any).onEvent('backButtonClicked', () => setView('event-list'));
      } catch {}
    }

    window.addEventListener('resize', updateViewport);
    return () => {
      if (hasOnEvent) {
        try {
          (tg as any).offEvent?.('viewportChanged', updateViewport);
          (tg as any).offEvent?.('backButtonClicked', () => setView('event-list'));
        } catch {}
      }
      window.removeEventListener('resize', updateViewport);
    };
  }, [telegramStatus]);

  useEffect(() => {
    // Refresh data every few seconds to simulate live updates (for lock expiry)
    const loadData = async () => {
      try {
        StorageService.cleanupExpiredLocks();
        const data = await StorageService.getEvents();
        setEvents(data);
      } catch (e) {
        setClientError((e as Error)?.message || 'Failed to load events');
      }
    };

    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSeatSelect = (seatId: string, tableId: string, price: number) => {
    const uniqueId = `${tableId}-${seatId}`;
    if (selectedSeats.includes(uniqueId)) {
      setSelectedSeats(prev => prev.filter(id => id !== uniqueId));
      setSelectedSeatIds(prev => prev.filter(id => id !== seatId));
      setSelectionTotal(prev => prev - price);
    } else {
      // Check max seats limit
      if (selectedSeats.length >= (selectedEvent?.maxSeatsPerBooking || 4)) {
        alert("Maximum seats reached for this booking.");
        return;
      }
      setSelectedSeats(prev => [...prev, uniqueId]);
      setSelectedSeatIds(prev => [...prev, seatId]);
      setSelectionTotal(prev => prev + price);
    }
  };

  const handleBooking = async () => {
    if (!selectedEvent || selectedSeats.length === 0 || !telegramUserId) {
      alert('Не удалось определить пользователя Telegram. Откройте бота через WebApp.');
      return;
    }

    try {
      const booking = await StorageService.createBooking(
        selectedEvent.id,
        selectedSeatIds,
      );

      const data = await StorageService.getEvents();
      setEvents(data);

      setSelectedSeats([]);
      setSelectedSeatIds([]);
      setSelectionTotal(0);
      (window as any).currentBooking = booking;
      // Keep a snapshot of the event for payment display
      (window as any).currentBookingEvent = selectedEvent;
      setView('booking-success');
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const renderEventList = () => (
    <div className="p-4 pb-20">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Upcoming Events</h1>
      <div className="space-y-6">
        {events.map(evt => (
          <div key={evt.id} className="bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-100">
            <div className="h-40 w-full relative">
              <img src={evt.imageUrl} className="w-full h-full object-cover" alt={evt.title} />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-4">
                <h2 className="text-white text-xl font-bold shadow-sm">{evt.title}</h2>
              </div>
            </div>
            <div className="p-4">
              <p className="text-gray-600 text-sm mb-4 line-clamp-2">{evt.description}</p>
              <div className="flex justify-between items-center">
                <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2 py-1 rounded">
                  <i className="far fa-calendar-alt mr-1"></i> {evt.date}
                </span>
                <button 
                  onClick={() => { setSelectedEvent(evt); setView('event-details'); }}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold active:scale-95 transition-transform"
                >
                  View Seats
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderEventDetails = () => {
    if (!selectedEvent) return null;
    
    // Re-fetch the specific event to get latest seat status
    const liveEvent = events.find(e => e.id === selectedEvent.id) || selectedEvent;

    return (
      <div className="flex flex-col h-screen bg-white">
        {/* Header */}
        <div className="p-4 border-b flex items-center gap-4 bg-white z-10">
          <button onClick={() => { setView('event-list'); setSelectedSeats([]); setSelectionTotal(0); }} className="text-gray-600">
            <i className="fas fa-arrow-left text-xl"></i>
          </button>
          <div>
            <h2 className="font-bold text-lg leading-tight">{liveEvent.title}</h2>
            <p className="text-xs text-gray-500">Select your seats</p>
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 bg-gray-50 overflow-hidden relative">
          <div className="absolute top-2 left-2 z-10 flex gap-2 text-xs">
            <div className="flex items-center gap-1 bg-white/80 px-2 py-1 rounded shadow"><div className="w-3 h-3 rounded-full bg-green-500"></div> Free</div>
            <div className="flex items-center gap-1 bg-white/80 px-2 py-1 rounded shadow"><div className="w-3 h-3 rounded-full bg-red-500"></div> Sold</div>
            <div className="flex items-center gap-1 bg-white/80 px-2 py-1 rounded shadow"><div className="w-3 h-3 rounded-full bg-yellow-500"></div> Locked</div>
          </div>
          
          <div className="p-4 h-full flex items-center">
            <SeatMap 
              event={liveEvent} 
              onSeatSelect={handleSeatSelect}
              selectedSeats={selectedSeats}
            />
          </div>
        </div>

        {/* Bottom Sheet */}
        <div className="p-4 border-t bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-20">
          <div className="flex justify-between items-center mb-4">
            <div>
              <p className="text-gray-500 text-sm">Selected</p>
              <p className="font-bold text-xl">{selectedSeats.length} seats</p>
            </div>
            <div className="text-right">
              <p className="text-gray-500 text-sm">Total</p>
              <p className="font-bold text-xl text-blue-600">{selectionTotal} ₽</p>
            </div>
          </div>
          <button 
            disabled={selectedSeats.length === 0}
            onClick={handleBooking}
            className="w-full bg-blue-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl shadow-lg active:scale-[0.98] transition-all"
          >
            Book & Pay
          </button>
        </div>
      </div>
    );
  };

  const renderBookingSuccess = () => {
    const booking = (window as any).currentBooking as Booking;
    const eventSnap = (window as any).currentBookingEvent as EventData | undefined;
    if (!booking) return <div onClick={() => setView('event-list')}>Error</div>;

    return (
      <div className="p-6 min-h-screen bg-gray-50 flex flex-col items-center justify-center text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
          <i className="fas fa-check text-2xl text-green-600"></i>
        </div>
        <h2 className="text-2xl font-bold mb-2">Seats Reserved!</h2>
        <p className="text-gray-600 mb-6 text-sm">Your seats are locked for <b>15 minutes</b>.</p>

        <div className="bg-white p-6 rounded-xl shadow-sm border w-full max-w-sm mb-6 text-left">
          <h3 className="font-bold border-b pb-2 mb-2">Payment Instructions</h3>
          <p className="mb-4 text-sm text-gray-700">Please transfer <b>{(booking.totalPrice ?? (booking.totalAmount as any))} ₽</b> via SBP (Fast Payment System) to:</p>
          <div className="bg-gray-100 p-3 rounded-lg flex justify-between items-center mb-4">
            <span className="font-mono font-bold text-lg">{eventSnap?.paymentPhone || selectedEvent?.paymentPhone}</span>
            <button className="text-blue-600 text-sm font-bold">COPY</button>
          </div>
          <p className="text-xs text-gray-500">
            Wait for the confirmation message from the bot with your tickets.
          </p>
        </div>

        <button 
          onClick={() => setView('event-list')}
          className="w-full max-w-sm bg-gray-800 text-white py-3 rounded-lg font-medium"
        >
          Back to Events
        </button>
      </div>
    );
  };

  const renderMyTickets = () => {
    const [myBookings, setMyBookings] = useState<Booking[] | null>(null);

    const [myTickets, setMyTickets] = useState<Booking[] | null>(null);

    useEffect(() => {
      const load = async () => {
        if (!telegramUserId) {
          setMyBookings([]);
          setMyTickets([]);
          return;
        }
        try {
          const [bookingsData, ticketsData] = await Promise.all([
            StorageService.getMyBookings(),
            StorageService.getMyTickets(),
          ]);
          setMyBookings(bookingsData);
          setMyTickets(ticketsData);
        } catch (e) {
          setClientError((e as Error)?.message || 'Failed to load your bookings');
          setMyBookings([]);
          setMyTickets([]);
        }
      };
      load();
    }, [telegramUserId]);

    // NOTE: viewport handlers moved to top-level effect when Telegram is ready

    if (myBookings === null) {
      return (
        <div className="p-4 pb-20 min-h-screen bg-gray-50">
          <h1 className="text-2xl font-bold mb-6">My Tickets</h1>
          <p className="text-gray-500">Loading...</p>
        </div>
      );
    }
    return (
      <div className="p-4 pb-20 min-h-screen bg-gray-50">
        <h1 className="text-2xl font-bold mb-6">My Tickets</h1>

        {/* Reserved (active) bookings */}
        <h2 className="text-lg font-semibold mb-3">Active Reservations</h2>
        {myBookings && myBookings.length === 0 && <p className="text-gray-500 mb-4">No active reservations.</p>}
        <div className="space-y-4 mb-6">
          {(myBookings || []).map(bk => {
            const event = events.find(e => e.id === bk.eventId);
            return (
              <div key={bk.id} className="bg-white rounded-xl overflow-hidden shadow-sm border relative">
                <div className={`h-2 w-full ${bk.status === 'confirmed' ? 'bg-green-500' : 'bg-yellow-400'}`}></div>
                <div className="p-4">
                  <h3 className="font-bold text-lg">{event?.title || 'Unknown Event'}</h3>
                  <div className="flex justify-between mt-2 text-sm text-gray-600">
                    <span>Reservation #{bk.id.slice(-4)}</span>
                    <span className={`font-bold ${bk.status === 'confirmed' ? 'text-green-600' : 'text-yellow-600'}`}>
                      {String(bk.status).toUpperCase()}
                    </span>
                  </div>
                  <div className="mt-4 border-t pt-2 border-dashed">
                    <p className="text-xs text-gray-400">SEATS</p>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {(bk.seatIds || []).map((sid: string) => (
                        <span key={sid} className="bg-gray-100 px-2 py-1 rounded text-xs font-mono">{sid}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="absolute top-1/2 -left-2 w-4 h-4 bg-gray-50 rounded-full"></div>
                <div className="absolute top-1/2 -right-2 w-4 h-4 bg-gray-50 rounded-full"></div>
              </div>
            );
          })}
        </div>

        <h2 className="text-lg font-semibold mb-3">Confirmed Tickets</h2>
        {myTickets && myTickets.length === 0 && <p className="text-gray-500 mb-4">No confirmed tickets yet.</p>}
        <div className="space-y-4">
          {(myTickets || []).map(tk => {
            const event = events.find(e => e.id === tk.eventId);
            return (
              <div key={tk.id} className="bg-white rounded-xl overflow-hidden shadow-sm border relative">
                <div className={`h-2 w-full bg-green-500`}></div>
                <div className="p-4">
                  <h3 className="font-bold text-lg">{event?.title || 'Unknown Event'}</h3>
                  <div className="flex justify-between mt-2 text-sm text-gray-600">
                    <span>Ticket #{tk.id.slice(-4)}</span>
                    <span className="font-bold text-green-600">CONFIRMED</span>
                  </div>
                  <div className="mt-4 border-t pt-2 border-dashed">
                    <p className="text-xs text-gray-400">SEATS</p>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {(tk.seatIds || []).map((sid: string) => (
                        <span key={sid} className="bg-gray-100 px-2 py-1 rounded text-xs font-mono">{sid}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="absolute top-1/2 -left-2 w-4 h-4 bg-gray-50 rounded-full"></div>
                <div className="absolute top-1/2 -right-2 w-4 h-4 bg-gray-50 rounded-full"></div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Main Render Switch
  return (
    <div className="max-w-md mx-auto min-h-screen bg-gray-50 shadow-2xl relative">
      
      {/* Dev Toggle */}
      {/* Telegram WebApp is the only auth entrypoint; admin UI shown only when backend grants role */}

      {isAdmin ? (
        <AdminPanel onBack={() => setIsAdmin(false)} />
      ) : (
        <>
          {view === 'event-list' && renderEventList()}
          {view === 'event-details' && renderEventDetails()}
          {view === 'booking-success' && renderBookingSuccess()}
          {view === 'my-tickets' && renderMyTickets()}

          {/* Bottom Nav (only visible on list or tickets) */}
          {(view === 'event-list' || view === 'my-tickets') && (
            <div className="fixed bottom-0 left-0 right-0 bg-white border-t flex justify-around p-3 z-40 max-w-md mx-auto">
              <button 
                onClick={() => setView('event-list')}
                className={`flex flex-col items-center text-xs ${view === 'event-list' ? 'text-blue-600' : 'text-gray-400'}`}
              >
                <i className="fas fa-search text-xl mb-1"></i>
                Events
              </button>
              <button 
                onClick={() => setView('my-tickets')}
                className={`flex flex-col items-center text-xs ${view === 'my-tickets' ? 'text-blue-600' : 'text-gray-400'}`}
              >
                <i className="fas fa-ticket-alt text-xl mb-1"></i>
                Tickets
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;