import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// design-core-path-tier1 §4 tests 3 and 3a — chunk 1, §1.2.
//
// The route is the BOUNDARY. The picker's `accept` is only a hint, so these
// assert the two halves that make the boundary real: classify by BYTES, and
// persist what the sniff determined rather than what the caller claimed.
//
// This route had no tests before, so the guard ships with its own safety net
// rather than relying on a green suite that never touched it.

const stored = {
  uploadArgs: null as null | { path: string; options: { contentType?: string } },
  upsertRow: null as null | Record<string, unknown>,
  removed: [] as string[],
};

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
      }),
      upsert: (row: Record<string, unknown>) => {
        stored.upsertRow = row;
        return {
          select: () => ({
            single: async () => ({
              data: { id: 'chart-1', ...row, updated_at: '2026-08-19T00:00:00Z' },
              error: null,
            }),
          }),
        };
      },
    }),
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, _body: unknown, options: { contentType?: string }) => {
          stored.uploadArgs = { path, options };
          return { error: null };
        },
        remove: async (paths: string[]) => {
          stored.removed.push(...paths);
          return { error: null };
        },
      }),
    },
  }),
}));

const { POST } = await import('@/app/api/charts/upload/route');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build the multipart request the modal sends. `type` is the CLAIMED mime. */
function uploadRequest(bytes: Uint8Array, name: string, type: string) {
  const form = new FormData();
  form.set('file', new File([bytes as BlobPart], name, ...(type ? [{ type }] : [])));
  form.set('song_title', 'Wonderwall');
  form.set('role', 'guitar');
  return new NextRequest('http://localhost/api/charts/upload', { method: 'POST', body: form });
}

beforeEach(() => {
  stored.uploadArgs = null;
  stored.upsertRow = null;
  stored.removed = [];
});

describe('test 3 — the guard classifies by BYTES, not the claimed MIME', () => {
  it('REJECTS png bytes even when the caller claims application/pdf', async () => {
    // ★ The distinguishing case. A MIME-only guard — the implementation Codex R1
    // rejected — passes this file straight through and strands every performer.
    const res = await POST(uploadRequest(PNG_BYTES, 'chart.pdf', 'application/pdf'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PDF/i);
    // Nothing may reach storage: rejection happens BEFORE the upload.
    expect(stored.uploadArgs).toBeNull();
    expect(stored.upsertRow).toBeNull();
  });

  it('ACCEPTS a real PDF whose type is missing entirely', async () => {
    // Browsers and OSes do supply an empty `type`. A MIME check would refuse a
    // perfectly good chart here — the sniff is strictly more permissive for the
    // 95%+ case that actually matters.
    const res = await POST(uploadRequest(PDF_BYTES, 'chart.pdf', ''));

    expect(res.status).toBe(201);
    expect(stored.uploadArgs).not.toBeNull();
  });

  it('rejects a file too short to carry a signature', async () => {
    const res = await POST(uploadRequest(new Uint8Array([0x25, 0x50]), 'tiny.pdf', 'application/pdf'));
    expect(res.status).toBe(400);
  });
});

describe('test 3a — a successful sniff NORMALIZES what we persist', () => {
  it('stores application/pdf for a real PDF mislabelled image/png', async () => {
    // ★ Assert the STORED values, not just the 200. An implementation that
    // sniffs correctly and then writes `file.type` passes test 3 and still
    // strands the file behind the viewer's image message — the exact
    // contradiction Codex R2 caught in the design.
    const res = await POST(uploadRequest(PDF_BYTES, 'chart.png', 'image/png'));

    expect(res.status).toBe(201);
    expect(stored.upsertRow?.mime_type).toBe('application/pdf');
    expect(stored.uploadArgs?.options.contentType).toBe('application/pdf');
  });

  it('stores the object under a .pdf path regardless of the uploaded name', async () => {
    // The extension follows the sniff too: a `.png` path serving application/pdf
    // is the same metadata disagreement in a different field.
    await POST(uploadRequest(PDF_BYTES, 'chart.png', 'image/png'));

    expect(stored.uploadArgs?.path).toBe('user-1/wonderwall/guitar.pdf');
  });

  it('records the response as a non-builder chart', async () => {
    const res = await POST(uploadRequest(PDF_BYTES, 'chart.pdf', 'application/pdf'));
    const body = await res.json();

    expect(body.is_builder).toBe(false);
    expect(body.mime_type).toBe('application/pdf');
  });

  it('de-builders the slot: clears source_spec, source_prompt AND source_notation', async () => {
    // Replacing a builder chart with a file must strand neither the authored spec,
    // the authoring prompt, NOR the baked notation in the row, or a file chart
    // keeps stale builder metadata (design-roadmap-prompt-persistence.md §4 tp5;
    // design-roadmap-notation-toggle.md §6).
    await POST(uploadRequest(PDF_BYTES, 'chart.pdf', 'application/pdf'));

    expect(stored.upsertRow?.source_spec).toBeNull();
    expect(stored.upsertRow?.source_prompt).toBeNull();
    expect(stored.upsertRow?.source_notation).toBeNull();
  });
});
