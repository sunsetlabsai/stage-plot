import { NextRequest } from 'next/server';
import {
  parseCsv,
  mapHeaders,
  parseRows,
  sheetCsvUrl,
  MissingTitleColumnError,
} from '@/lib/setlist-import';

// Reads a public Google Sheet as CSV and returns ImportedRow[].
//
// Parsing, header mapping and ordering live in lib/setlist-import.ts so they
// are unit-testable without a network (design §8). This route keeps what only
// it can do: the fetch, and mapping failures onto status codes.
//
// The merge itself stays client-side — the preview re-runs it when the removal
// checkbox is toggled, with no refetch (design §7, §12 Q3 closed).

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  if (!url) {
    return Response.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  }

  const csvUrl = sheetCsvUrl(url);
  if (!csvUrl) {
    return Response.json({ error: 'Invalid Google Sheets URL' }, { status: 400 });
  }

  try {
    const res = await fetch(csvUrl);
    if (!res.ok) {
      return Response.json(
        { error: `Failed to fetch sheet (${res.status})` },
        { status: 502 },
      );
    }

    const rows = parseCsv(await res.text());
    if (rows.length < 2) {
      return Response.json({ error: 'Sheet has no data rows' }, { status: 422 });
    }

    let fields;
    try {
      fields = mapHeaders(rows[0]);
    } catch (e) {
      if (e instanceof MissingTitleColumnError) {
        return Response.json({ error: e.message }, { status: 422 });
      }
      throw e;
    }

    return Response.json({
      songs: parseRows(rows.slice(1), fields),
      // Which recognized-but-not-imported columns were present, so the preview
      // can say what it is ignoring and why (design §7, §10) rather than
      // silently dropping a column the user deliberately filled in.
      ignored: {
        bpm: fields.bpm !== undefined,
        artist: fields.artist !== undefined,
      },
    });
  } catch (e) {
    return Response.json(
      { error: `Fetch error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
