import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

router.post('/dev-admin-login', (req, res) => {
  const { login, password } = req.body;

  if (
    login !== process.env.ADMIN_LOGIN ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    {
      id: 'admin',
      role: 'admin',
    },
    process.env.JWT_SECRET!,
    { expiresIn: '8h' }
  );

  res.json({ token });
});

router.post('/dev-user-login', (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const token = jwt.sign(
    {
      id: userId,
      role: 'user',
    },
    process.env.JWT_SECRET!,
    { expiresIn: '8h' }
  );

  res.json({ token });
});

router.post('/telegram', (req, res) => {
  // Guard against missing body (ensure JSON parsing worked) and accept fallback query params
  const body = req && typeof req.body === 'object' ? req.body : {};
  let rawId: unknown = body.telegramId ?? body.telegram_id ?? body.userId ?? body.user_id ?? body.id ?? req.query?.telegramId ?? req.query?.telegram_id ?? req.query?.userId ?? req.query?.user_id ?? req.query?.id;

  if (rawId === undefined || rawId === null) {
    return res.status(400).json({ error: 'telegramId is required and must be provided in the request body or query string' });
  }

  // Normalize: accept numbers or numeric strings; trim strings
  if (typeof rawId === 'string') rawId = rawId.trim();

  if (rawId === '') {
    return res.status(400).json({ error: 'telegramId must not be empty' });
  }

  // Try numeric normalization first; fall back to string id
  const asNumber = Number(rawId as any);
  const normalizedId: number | string = Number.isFinite(asNumber) ? asNumber : String(rawId);

  // Ensure JWT secret is present
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'Server misconfiguration: JWT secret not set' });
  }

  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const role = adminIds.includes(String(normalizedId)) ? 'admin' : 'user';

  try {
    const token = jwt.sign(
      {
        id: String(normalizedId),
        role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({ token, role });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate token' });
  }
});



export default router;
