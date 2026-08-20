import { describe, it, expect } from 'vitest';
import { isUnsupportedChartMime, PDF_MIME, sniffPdf } from '@/lib/chart-converter';
import { isTitleEditableInSetlist } from '@/lib/setlist';
import { EXPORT_MIME_TYPES } from '@/lib/drive';

// design-core-path-tier1 §4 tests 4 and 5 — chunk 1, §1.2 part 3 and §1.3.
//
// The rules live in lib/ so a test can hold them; the page keeps the JSX. Same
// move §2.3 makes for the id normalizers and #136 made for the probe.

describe('test 4 — the viewer can say WHY a legacy chart will not render', () => {
  it('flags a stored image as unsupported', () => {
    expect(isUnsupportedChartMime('image/png')).toBe(true);
    expect(isUnsupportedChartMime('image/jpeg')).toBe(true);
  });

  it('does NOT flag a PDF', () => {
    expect(isUnsupportedChartMime(PDF_MIME)).toBe(false);
  });

  it('★ does NOT flag an ABSENT mime — unknown is not unsupported', () => {
    // The distinguishing case. Older rows carry no MIME at all and are
    // overwhelmingly PDFs. The plausible-wrong predicate is
    // `mimeType !== PDF_MIME`, which passes the two tests above and then refuses
    // to render charts that work in production today.
    expect(isUnsupportedChartMime(undefined)).toBe(false);
    expect(isUnsupportedChartMime('')).toBe(false);
  });

  it('★★ does NOT flag a Google-native type — the proxy exports it to PDF', () => {
    // ★ Codex R1 High. These render in production TODAY: drive/batch stores the
    // real Google MIME, and lib/pdf-viewer posts it to /api/drive/download, which
    // exports Docs/Sheets/Slides to PDF before pdf.js ever sees bytes. The first
    // implementation refused exactly the charts that export path exists to serve
    // and told the user "This chart is an image".
    for (const mime of Object.keys(EXPORT_MIME_TYPES)) {
      expect(isUnsupportedChartMime(mime)).toBe(false);
    }
  });

  it('stays in agreement with the export map as it grows', () => {
    // The map has two consumers now (the export route and this predicate). This
    // pins them to ONE definition: adding a Google type must teach both at once,
    // which is what putting the map in lib/drive.ts buys. A duplicated list is
    // how the R1 regression comes back.
    for (const [source, target] of Object.entries(EXPORT_MIME_TYPES)) {
      expect(target).toBe(PDF_MIME); // everything exports TO pdf, or the viewer still can't draw it
      expect(isUnsupportedChartMime(source)).toBe(false);
    }
  });

  it('★ pins the exportable types by NAME, so one cannot quietly leave', () => {
    // Mutation testing caught the gap: the loop above iterates the map, so
    // DELETING a type passes it — the assertion shrinks with its own input.
    // Both consumers would then agree that Slides are unrenderable, which is
    // consistent and still a silently dropped format. Removing one of these is a
    // supported-format decision and must fail here first.
    expect(Object.keys(EXPORT_MIME_TYPES).sort()).toEqual([
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.spreadsheet',
    ]);
  });

  it('still flags a genuine image, which no export path rescues', () => {
    // The guard must not become "allow everything" while fixing the R1 High.
    expect(isUnsupportedChartMime('image/png')).toBe(true);
    expect(isUnsupportedChartMime('application/vnd.google-apps.folder')).toBe(true);
  });

  it('agrees with the upload guard: anything the sniff accepts is renderable', () => {
    // Pins the two halves of the PDF contract against each other. After §1.2
    // part 2b a sniff-accepted file is persisted as PDF_MIME, so the viewer must
    // never flag it — if these two ever disagree, a chart we accepted becomes a
    // chart we refuse to show.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(sniffPdf(pdf)).toBe(true);
    expect(isUnsupportedChartMime(PDF_MIME)).toBe(false);
  });
});

describe('test 5 — a title is editable in the setlist ONLY when unlinked', () => {
  it('a library-linked row is NOT editable', () => {
    // The server rewrites it from `songs.title` on every save, so offering the
    // field is offering a write that silently reverts.
    expect(isTitleEditableInSetlist({ songId: 'song-1' })).toBe(false);
  });

  it('★ a row with NO songId IS editable', () => {
    // Both directions matter. This is the half a blanket read-only would break:
    // `shows/update/route.ts` resolves — or auto-creates — such a row BY its
    // title, so CSV/sheet import and the agent's update_setlist depend on it.
    expect(isTitleEditableInSetlist({ songId: undefined })).toBe(true);
    expect(isTitleEditableInSetlist({})).toBe(true);
  });

  it('treats an empty-string songId as unlinked', () => {
    // Defensive but real: an empty id is not a link, and treating it as one
    // would freeze a row nothing can rename.
    expect(isTitleEditableInSetlist({ songId: '' })).toBe(true);
  });
});
