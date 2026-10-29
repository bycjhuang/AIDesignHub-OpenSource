'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Runs against the real renderer and IPC bridge using the isolated main-process
// transport fixture. All collection, selection, saving and exporting use UI.
exports.run = async ({ win, sourceUrl, output }) => {
  const checks = await win.webContents.executeJavaScript(`(${(async expectedUrl => {
    const $ = id => document.getElementById(id);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const waitFor = async (predicate, message, refresh = false) => {
      for (let attempt = 0; attempt < 400; attempt++) {
        if (predicate()) return;
        // Hidden/offscreen windows deliberately suspend automatic UI polling.
        if (refresh && attempt % 12 === 0 && !$('imageCollectionRefresh').disabled) $('imageCollectionRefresh').click();
        await sleep(50);
      }
      throw new Error(`${message}: ${$('imageCollectionError')?.textContent || $('imageCollectionDialog')?.innerText.slice(-1200)}`);
    };
    const cards = () => [...$('imageCollectionGrid').querySelectorAll('.ic-image-card')];
    const change = (node, value) => { if (node.type === 'checkbox') node.checked = value; else node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
    await waitFor(() => $('imageCollectionDialog')?.open && !$('imageCollectionStart').disabled, 'Image workbench did not open');
    check($('imageCollectionUrl').value === expectedUrl, 'Source URL was not prefilled');
    check($('imageCollectionMode').value === 'static', 'Static collection is not the initial mode');
    $('imageCollectionStart').click();
    await waitFor(() => cards().length === 4 && !$('imageCollectionStart').disabled, 'Four fixture candidates did not finish', true);
    check(cards().filter(card => card.dataset.imageStatus === 'ready').length === 2, 'Expected two unique ready candidates');
    check(cards().some(card => card.dataset.imageStatus === 'duplicate'), 'Duplicate candidate is not marked');
    check(cards().some(card => card.dataset.imageStatus === 'error' && card.textContent.includes('固定样本')), 'Failed candidate lacks its reason');
    check(!window.collectionXss && cards().some(card => card.textContent.includes('<img src=x onerror=')), 'Untrusted image text was not escaped');
    check(!$('imageCollectionGrid').querySelector('[onerror]'), 'Untrusted image markup entered the DOM');
    const collected = true;
    change($('imageCollectionHd'), true);
    check(cards().length === 1 && Number(cards()[0].dataset.width) === 1800, 'HD filter did not isolate the original high-resolution image');
    const hdFiltered = true;
    change($('imageCollectionHd'), false);
    $('imageCollectionSelectAll').click();
    check($('imageCollectionGrid').querySelectorAll('input[type=checkbox]:checked').length === 2, 'Select visible included a failed or duplicate candidate');
    $('imageCollectionNote').value = '烟测归档备注：立面与空间参考 <script>不执行</script>';
    check(!$('imageCollectionSave').disabled, 'Selected originals cannot be saved');
    $('imageCollectionSave').click();
    await waitFor(() => new Set(cards().filter(card => card.dataset.imageStatus === 'saved').map(card => card.dataset.savedAssetId)).size === 2 && !$('imageCollectionStart').disabled, 'Two distinct originals were not archived', true);
    const archived = true;
    $('imageCollectionLibraryTab').click();
    await waitFor(() => $('imageCollectionLibraryTab').getAttribute('aria-selected') === 'true' && cards().length === 2, 'Project image library did not load');
    check(cards().every(card => card.textContent.includes('烟测归档备注')), 'Archive notes were not persisted');
    const libraryLoaded = true;
    const large = cards().find(card => Number(card.dataset.width) === 1800);
    check(Boolean(large), 'Large original is missing from the archive');
    large.querySelector('.ic-card-preview').click();
    await waitFor(() => $('imageCollectionViewer').open && $('imageCollectionViewer').querySelector('.ic-preview-media img')?.naturalWidth > 400, 'Large preview was not read from the archived original');
    const previewImage = $('imageCollectionViewer').querySelector('.ic-preview-media img');
    check(previewImage.naturalWidth === 1800 && previewImage.naturalHeight === 1080, 'Large preview used thumbnail dimensions');
    check(/^data:image\//.test(previewImage.src), 'Preview is not a bounded main-process raster');
    const originalPreview = true;
    $('imageCollectionViewer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(!$('imageCollectionViewer').open && $('imageCollectionDialog').open, 'Escape did not close only the preview');
    check(document.activeElement?.classList.contains('ic-card-preview'), 'Preview did not restore focus');
    const focusAndEscape = true;
    $('imageCollectionSelectAll').click();
    check($('imageCollectionGrid').querySelectorAll('input:checked').length === 2 && !$('imageCollectionExport').disabled, 'Archived originals cannot be selected for export');
    $('imageCollectionExport').click();
    await waitFor(() => !$('imageCollectionExport').disabled && $('imageCollectionDialog').innerText.includes('导出已完成'), 'Export did not complete');
    const exported = true;
    // An original already present in the library must remain selectable when
    // another page/case discovers it, so its new source can be confirmed.
    $('imageCollectionCandidatesTab').click();
    $('imageCollectionStart').click();
    await waitFor(() => cards().length === 4 && !$('imageCollectionStart').disabled, 'Existing-content collection did not finish', true);
    check($('imageCollectionGrid').querySelectorAll('input[type=checkbox]:not(:disabled)').length === 2, 'Existing originals cannot receive a new confirmed source');
    $('imageCollectionSelectAll').click();
    $('imageCollectionSave').click();
    await waitFor(() => new Set(cards().map(card => card.dataset.savedAssetId).filter(Boolean)).size === 2 && !$('imageCollectionStart').disabled, 'Existing source confirmation failed', true);
    $('imageCollectionLibraryTab').click();
    await waitFor(() => cards().length === 2, 'Source confirmation duplicated archived originals');
    const existingSourceConfirmed = true;
    const dialog = $('imageCollectionDialog'), body = dialog.querySelector('.ic-body');
    check(dialog.getBoundingClientRect().right <= innerWidth + 1 && dialog.getBoundingClientRect().left >= -1 && body.scrollWidth <= body.clientWidth + 2, 'Image workbench has horizontal overflow');
    check(!window.collectionXss, 'Untrusted source executed during archive viewing');
    return { collected, hdFiltered, archived, libraryLoaded, originalPreview, exported, existingSourceConfirmed, focusAndEscape, escapedText: true, noHorizontalOverflow: true };
  }).toString()})(${JSON.stringify(sourceUrl)})`);
  assert.ok(Object.values(checks).every(value => value === true), 'Every image workbench UI check passed');
  const exportedFiles = fs.readdirSync(output, { recursive: true });
  assert.ok(exportedFiles.some(name => /manifest.*\.json$|sources.*\.json$|来源.*\.json$/i.test(name)), 'Export contains a source manifest');
  fs.writeFileSync(path.join(output, 'image-library.png'), (await win.webContents.capturePage()).toPNG());
  return checks;
};
