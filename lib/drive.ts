// Shared Google Drive API utilities

export class DriveAuthError extends Error {
  constructor() { super('Drive auth failed'); }
}

export type DriveFile = { id: string; name: string; webViewLink: string; mimeType?: string; modifiedTime?: string };

/**
 * Google-native types the Drive API can EXPORT to PDF, and the type it exports to.
 *
 * These charts carry a real Google MIME (`drive/batch/route.ts` stores
 * `file.mimeType` verbatim) and are perfectly renderable: the viewer posts
 * `chart.mimeType` to `/api/drive/download`, which exports to PDF before the
 * bytes ever reach pdf.js.
 *
 * ★ This map lives here, not in the download route, because it now has TWO
 * consumers — the export path and `isUnsupportedChartMime`, which must agree on
 * what "renderable" means. Codex R1 caught the viewer refusing exactly the
 * charts this export path exists to serve; duplicating the list is how that
 * disagreement would come back. Adding a type here teaches both at once.
 */
export const EXPORT_MIME_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
};

const SHARED_DRIVE_PARAMS = {
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
};

export async function driveQuery(
  q: string,
  accessToken: string,
  fields = 'id, name, webViewLink',
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q,
    fields: `files(${fields})`,
    pageSize: '100',
    ...SHARED_DRIVE_PARAMS,
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new DriveAuthError();
    const text = await res.text();
    throw new Error(`Drive query failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { files: DriveFile[] };
  return data.files ?? [];
}

export async function driveQueryAll(
  q: string,
  accessToken: string,
  fields = 'id, name, webViewLink',
): Promise<DriveFile[]> {
  const all: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q,
      fields: `nextPageToken, files(${fields})`,
      pageSize: '100',
      ...SHARED_DRIVE_PARAMS,
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new DriveAuthError();
      const text = await res.text();
      throw new Error(`Drive query failed (${res.status}): ${text}`);
    }
    const data = await res.json() as { files: DriveFile[]; nextPageToken?: string };
    all.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[^.]+$/, '')           // strip file extension
    .replace(/[^a-z0-9\s]/g, '')       // strip punctuation
    .replace(/^(the|a|an)\s+/, '')     // strip leading articles
    .replace(/\s+/g, ' ')
    .trim();
}
