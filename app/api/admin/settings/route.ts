import { NextRequest } from 'next/server';
import { getAllAdminConfig, setAdminConfig, isKvConnected } from '@/lib/admin-config';
import { checkRateLimit, getIp, authenticate } from '@/lib/admin-rate-limit';

export async function GET(request: NextRequest) {
  const ip = getIp(request);
  if (!checkRateLimit(ip, 'settings')) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }

  if (!authenticate(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kvConnected = await isKvConnected();
  if (!kvConnected) {
    return Response.json(
      { error: 'KV store not connected. Link a KV store in your Vercel dashboard.' },
      { status: 503 },
    );
  }

  const config = await getAllAdminConfig();
  return Response.json({ config, kvConnected });
}

export async function PUT(request: NextRequest) {
  const ip = getIp(request);
  if (!checkRateLimit(ip, 'settings')) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }

  if (!authenticate(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kvConnected = await isKvConnected();
  if (!kvConnected) {
    return Response.json(
      { error: 'KV store not connected. Cannot save settings without persistence.' },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const allowedKeys = ['google_client_id', 'google_client_secret', 'claude_tryit_key'];
  const updates: string[] = [];

  for (const key of allowedKeys) {
    if (key in body) {
      const value = body[key];
      if (typeof value !== 'string') {
        return Response.json({ error: `Invalid value for ${key}: must be a string` }, { status: 400 });
      }
      await setAdminConfig(key, value);
      updates.push(key);
    }
  }

  const config = await getAllAdminConfig();
  return Response.json({ config, updated: updates });
}
