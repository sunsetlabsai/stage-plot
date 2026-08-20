import { describe, it, expect } from 'vitest';
import { isUnsupportedChartMime, PDF_MIME, sniffPdf } from '@/lib/chart-converter';
import { isTitleEditableInSetlist } from '@/lib/setlist';

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
    // The distinguishing case. Older rows and Drive charts carry no MIME at all
    // and are overwhelmingly PDFs. The plausible-wrong predicate is
    // `mimeType !== PDF_MIME`, which passes the two tests above and then refuses
    // to render charts that work in production today.
    expect(isUnsupportedChartMime(undefined)).toBe(false);
    expect(isUnsupportedChartMime('')).toBe(false);
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
