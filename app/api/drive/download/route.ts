import { NextRequest } from 'next/server';
import { DriveAuthError, EXPORT_MIME_TYPES } from '@/lib/drive';

// Google Workspace MIME types that need export (can't be downloaded directly)
// Simple in-memory rate limit: max 60 unauthenticated requests per IP per minute
const unauthRateMap = new Map<string, { count: number; resetAt: number }>();
const UNAUTH_RATE_LIMIT = 60;
const UNAUTH_RATE_WINDOW_MS = 60_000;

function checkUnauthRate(ip: string): boolean {
  const now = Date.now();
  let entry = unauthRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + UNAUTH_RATE_WINDOW_MS };
    unauthRateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= UNAUTH_RATE_LIMIT;
}

// Proxies a Drive file download. Handles Google Docs -> PDF export.
// POST /api/drive/download
// Authorization: Bearer <access_token> (optional for public files)
// Body: { fileId: string, mimeType?: string }
export async function POST(request: NextRequest) {
  const accessToken = request.headers.get('authorization')?.replace('Bearer ', '') || null;

  // Rate limit unauthenticated requests
  if (!accessToken) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkUnauthRate(ip)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }
  }

  let body: { fileId: string; mimeType?: string };
  try {
    body = await request.json() as { fileId: string; mimeType?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.fileId || typeof body.fileId !== 'string') {
    return Response.json({ error: 'Missing or invalid fileId' }, { status: 400 });
  }

  try {
    const exportMime = body.mimeType ? EXPORT_MIME_TYPES[body.mimeType] : undefined;

    let url: string;
    const fetchHeaders: Record<string, string> = {};

    if (accessToken) {
      // Authenticated: use Drive API
      fetchHeaders['Authorization'] = `Bearer ${accessToken}`;
      if (exportMime) {
        url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(body.fileId)}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`;
      } else {
        url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(body.fileId)}?alt=media&supportsAllDrives=true`;
      }
    } else {
      // Unauthenticated: use public download URL (no API key needed for shared files)
      url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(body.fileId)}&confirm=t`;
    }

    const res = await fetch(url, { headers: fetchHeaders, redirect: 'follow' });

    // Handle auth/permission failures BEFORE export-size check
    if (res.status === 401 || res.status === 403) {
      // Distinguish: authenticated 403 on export = likely too large;
      // unauthenticated or non-export 403 = permission denied
      if (res.status === 403 && exportMime && accessToken) {
        return Response.json(
          { error: 'export_too_large', fileId: body.fileId },
          { status: 413 },
        );
      }
      throw new DriveAuthError();
    }

    if (res.status === 413) {
      return Response.json(
        { error: 'export_too_large', fileId: body.fileId },
        { status: 413 },
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      return Response.json(
        { error: `Drive download failed (${res.status}): ${text}` },
        { status: 502 },
      );
    }

    const contentType = exportMime ?? res.headers.get('content-type') ?? 'application/octet-stream';
    const bytes = await res.arrayBuffer();

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    if (e instanceof DriveAuthError) {
      return Response.json(
        { error: accessToken ? 'Google session expired — reconnect in Setup' : 'File is not publicly accessible' },
        { status: accessToken ? 401 : 403 },
      );
    }
    return Response.json(
      { error: `Download error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
