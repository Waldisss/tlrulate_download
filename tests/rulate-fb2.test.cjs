const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'rulate-fb2.user.js'), 'utf8');
const origin = 'https://tl.rulate.ru/book/12345';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlCZKwAAAAASUVORK5CYII=', 'base64');

function setup(body, options = {}) {
    const dom = new JSDOM(`<!doctype html><html><head>${options.head || ''}</head><body>${body}</body></html>`, {
        url: options.url || origin,
        runScripts: 'outside-only',
    });
    dom.window.__RULATE_FB2_TEST_MODE__ = true;
    dom.window.eval(source);
    return { dom, window: dom.window, document: dom.window.document, api: dom.window.__RULATE_FB2_TEST_API__ };
}

function chapterRow(id, title, { read = true, checkbox = false, hidden = false } = {}) {
    return `<tr class="chapter_row${hidden ? ' hidden-volume' : ''}" data-id="${id}"${hidden ? ' style="display:none"' : ''}>
        <td class="t"><a href="${origin}/${id}/ready_new">${title}</a></td>
        <td>${read ? `<a href="${origin}/${id}/ready_new">читать</a>` : '<span>читать</span>'}</td>
        <td>${checkbox ? '<input type="checkbox" name="download_chapter[]">' : ''}</td></tr>`;
}

function volumeRow(title) {
    return `<tr class="volume_helper"><td><strong>${title}</strong></td><td><a href="${origin}/downloadVolume">скачать том</a></td></tr>`;
}

function table(chapters, count = '0') {
    return `<select name="c_countOnPage"><option value="0"${count === '0' ? ' selected' : ''}>Все</option><option value="100"${count === '100' ? ' selected' : ''}>100</option></select>
        <table id="Chapters"><tbody>${chapters}</tbody></table>`;
}

function chapterHtml(id, content = '<p>Синтетический текст.</p>') {
    return `<!doctype html><html><body><div id="scroll_chapter_${id}"><div class="content-text">${content}</div></div><script>window.executed = true</script></body></html>`;
}

async function waitFor(check, timeout = 5000) {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeout) throw new Error('Timed out waiting for UI state');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function response(html, url, status = 200) {
    return { status, ok: status >= 200 && status < 300, url, text: async () => html };
}

function mockImages(window, data = pixel) {
    let calls = 0;
    window.GM_xmlhttpRequest = (options) => {
        calls++;
        queueMicrotask(() => options.onload({ status: 200, response: Uint8Array.from(data).buffer }));
        return { abort: () => options.onabort() };
    };
    return () => calls;
}

function captureDownloads(window) {
    const blobs = [];
    const setTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => ms === 60000 ? 0 : setTimeout(callback, ms, ...args);
    window.URL.createObjectURL = (blob) => {
        blobs.push(blob);
        return 'blob:synthetic';
    };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
    return blobs;
}

function blobText(window, blob) {
    return new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
}

test('keeps chapters inside their volume, in page order, without duplicates or paid-only rows', () => {
    const html = table([
        chapterRow(8, 'Пролог'),
        volumeRow('Том 1. Первый'),
        chapterRow(12, 'Глава 1-1', { hidden: true }),
        chapterRow(13, 'Глава 1-2'),
        chapterRow(13, 'Глава 1-2 — повтор'),
        chapterRow(14, 'Глава другой книги').replaceAll(origin, 'https://tl.rulate.ru/book/98765'),
        '<tr class="volume_helper"><td></td></tr>',
        chapterRow(15, 'Вне тома'),
        volumeRow('Том 2. Второй'),
        chapterRow(20, 'Глава 2', { checkbox: false }),
        chapterRow(21, 'Покупка', { read: false }),
        '<tr class="volume_helper"><td></td></tr>',
    ].join(''));
    const { document, api } = setup(html);
    const volumes = api.getVolumes(document);
    assert.equal(volumes.length, 2);
    assert.deepEqual(Array.from(volumes[0].chapters, (chapter) => chapter.id), ['12', '13']);
    assert.deepEqual(Array.from(volumes[1].chapters, (chapter) => chapter.id), ['20']);
    assert.equal(volumes[0].chapters[0].title, 'Глава 1-1');
    api.addVolumeButtons(document);
    api.addVolumeButtons(document);
    assert.equal(document.querySelectorAll('.rulate-fb2-button').length, 2);
    assert.equal(document.querySelectorAll('.rulate-fb2-button')[0].closest('td').textContent.includes('скачать том'), true);
});

test('uses the current book title and ID and rejects chapter links from a different book', () => {
    const context = setup('<h1>Другая книга &amp; тест</h1>' + table(
        volumeRow('Том 1. Первый')
        + chapterRow(12, 'Своя глава')
        + chapterRow(13, 'Чужая глава').replaceAll(origin, 'https://tl.rulate.ru/book/98765'),
    ));
    assert.equal(context.api.getBookTitle(context.document), 'Другая книга & тест');
    assert.deepEqual(Array.from(context.api.getVolumes(context.document)[0].chapters, (chapter) => chapter.id), ['12']);
    const xml = context.api.buildFb2({ title: 'Том 1. Первый' }, [
        { id: '12', title: 'Своя глава', body: '<p>Тест</p>' },
    ], new Map(), null, { bookTitle: context.api.getBookTitle(context.document), author: 'Автор' });
    assert.match(xml, /<book-title>Другая книга &amp; тест — Том 1\. Первый<\/book-title>/);
    assert.match(xml, /<src-url>https:\/\/tl\.rulate\.ru\/book\/12345<\/src-url>/);
    assert.match(xml, /<id>rulate-12345-volume-12<\/id>/);
    assert.match(xml, /<genre>unrecognised<\/genre>/);
});

test('blocks a paginated table before making requests', async () => {
    const { window, document, api } = setup(table(volumeRow('Том 1. Первый') + chapterRow(12, 'Глава'), '100'));
    let calls = 0;
    window.fetch = () => { calls++; throw new Error('unexpected request'); };
    api.addVolumeButtons(document);
    document.querySelector('.rulate-fb2-button').click();
    await waitFor(() => document.querySelector('[role="status"]').textContent.includes('Все'));
    assert.equal(calls, 0);
    assert.equal(api.allChaptersVisible(document), false);
});

test('recognizes denied and login pages even with HTTP 200, and rejects empty chapters', () => {
    const { window, api } = setup('');
    assert.throws(() => api.parseChapterHtml('<h1>Доступ запрещён</h1>', '12', origin + '/12/ready_new'), api.errors.AccessDeniedError);
    assert.throws(() => api.parseChapterHtml('<form action="/login"></form>', '12', origin + '/login'), api.errors.AccessDeniedError);
    assert.throws(() => api.parseChapterHtml('<div id="scroll_chapter_12"><div class="content-text">   </div></div>', '12', origin + '/12/ready_new'), api.errors.UnknownChapterError);
    assert.throws(() => api.parseChapterHtml(chapterHtml('13'), '12', origin + '/12/ready_new'), api.errors.UnknownChapterError);
    assert.equal(api.parseChapterHtml(chapterHtml('12'), '12', origin + '/12/ready_new').className, 'content-text');
    assert.equal(window.executed, undefined);
});

test('creates well-formed FB2 with formatting, escaped text, links and deduplicated image binaries', async () => {
    const { window, api } = setup('', { head: '<meta property="book:author" content="Синтетический автор">' });
    const calls = mockImages(window);
    const job = { cancelled: false, images: new Map(), failedImages: 0, activeImageRequest: null };
    const root = api.parseChapterHtml(chapterHtml('12', '<p>Тест &amp; &lt;тег&gt; <strong>жирный</strong> <em>курсив</em> <a href="https://example.org/?a=1&amp;b=2">ссылка</a></p><p>&nbsp;</p><p><img src="https://i.imgur.com/sample.png"></p><p><img src="https://i.imgur.com/sample.png"></p>'), '12', origin + '/12/ready_new');
    const body = await api.renderBlocks(root, job, origin + '/12/ready_new');
    const binaries = new Map();
    for (const [url, loading] of job.images) binaries.set(url, await loading);
    const xml = api.buildFb2({ title: 'Том 1. Первый' }, [{ id: '12', title: 'Глава 1 & <2>', body }], binaries, [...binaries.values()][0], { author: 'Автор & Co', bookTitle: 'Другая книга' });
    const parsed = new window.DOMParser().parseFromString(xml, 'application/xml');
    assert.equal(parsed.querySelector('parsererror'), null);
    const ns = 'http://www.gribuser.ru/xml/fictionbook/2.0';
    assert.equal(parsed.documentElement.namespaceURI, ns);
    assert.equal(parsed.getElementsByTagNameNS(ns, 'section').length, 1);
    assert.equal(parsed.getElementsByTagNameNS(ns, 'binary').length, 1);
    assert.equal(parsed.getElementsByTagNameNS(ns, 'empty-line').length, 1);
    assert.equal(parsed.getElementsByTagNameNS(ns, 'strong')[0].textContent, 'жирный');
    assert.equal(parsed.getElementsByTagNameNS(ns, 'emphasis')[0].textContent, 'курсив');
    assert.equal(parsed.getElementsByTagNameNS(ns, 'a')[0].getAttributeNS('http://www.w3.org/1999/xlink', 'href'), 'https://example.org/?a=1&b=2');
    assert.equal(parsed.getElementsByTagNameNS(ns, 'author')[0].textContent, 'Автор & Co');
    assert.equal(parsed.getElementsByTagNameNS(ns, 'image').length, 3);
    assert.equal(calls(), 1);
    const imageId = parsed.getElementsByTagNameNS(ns, 'binary')[0].getAttribute('id');
    for (const image of parsed.getElementsByTagNameNS(ns, 'image')) {
        assert.equal(image.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), '#' + imageId);
    }
    if (process.env.FB2_SCHEMA) {
        const validation = spawnSync('xmllint', ['--noout', '--schema', process.env.FB2_SCHEMA, '-'], {
            input: xml, encoding: 'utf8',
        });
        assert.equal(validation.status, 0, validation.stderr);
    }
});

test('removes repeated empty editor paragraphs while keeping an extra scene break', async () => {
    const { api } = setup('');
    const gap = '<p></p><p><br></p>';
    const paragraphs = ['Первый', 'Второй', 'Третий', 'Четвёртый', 'Пятый', 'Шестой'];
    const content = '<p></p>' + paragraphs.map((text, index) =>
        `<p>${text}</p>${index < paragraphs.length - 1 ? gap + (index === 2 ? gap : '') : ''}`).join('') + '<p></p>';
    const root = api.parseChapterHtml(chapterHtml('12', content), '12', origin + '/12/ready_new');
    const body = await api.renderBlocks(root, { cancelled: false, images: new Map(), failedImages: 0 }, origin + '/12/ready_new');
    assert.equal(body, '<p>Первый</p>\n<p>Второй</p>\n<p>Третий</p>\n<empty-line/>\n<p>Четвёртый</p>\n<p>Пятый</p>\n<p>Шестой</p>');
});

test('retries transient chapter failures and stops on cancellation', async () => {
    const { window, api } = setup('');
    let calls = 0;
    window.fetch = async (url) => {
        calls++;
        return calls === 1 ? response('', url, 503) : response(chapterHtml('12'), url);
    };
    const job = { cancelled: false, activeController: null, cancelDelay: null };
    const root = await api.fetchChapter(job, { id: '12', url: origin + '/12/ready_new', title: 'Глава' });
    assert.equal(root.className, 'content-text');
    assert.equal(calls, 2);

    const wait = setup('');
    let requestStarted = false;
    wait.window.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        requestStarted = true;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    });
    const cancellingJob = { cancelled: false, activeController: null, cancelDelay: null, resolvePause: null };
    const pending = wait.api.fetchChapter(cancellingJob, { id: '12', url: origin + '/12/ready_new', title: 'Глава' });
    await waitFor(() => requestStarted);
    wait.api.cancelJob(cancellingJob);
    await assert.rejects(pending, wait.api.errors.CancelledError);
});

test('offers partial save after exhausted retries and does not save on cancel', async () => {
    const html = table(volumeRow('Том 1. Первый') + chapterRow(12, 'Глава 1') + chapterRow(13, 'Глава 2') + '<tr class="volume_helper"><td></td></tr>');
    const context = setup(html);
    const blobs = captureDownloads(context.window);
    let failedCalls = 0;
    context.window.fetch = async (url) => {
        if (url.includes('/13/')) { failedCalls++; return response('', url, 503); }
        return response(chapterHtml('12'), url);
    };
    context.api.addVolumeButtons(context.document);
    const volume = context.api.getVolumes(context.document)[0];
    const cell = context.document.querySelector('.rulate-fb2-button').closest('td');
    const controls = {
        status: cell.querySelector('[role="status"]'),
        cancelButton: [...cell.querySelectorAll('button')].find((button) => button.textContent === 'Отмена'),
        actions: cell.lastElementChild,
    };
    const pending = context.api.downloadVolume(volume, controls);
    await waitFor(() => [...controls.actions.querySelectorAll('button')].some((button) => button.textContent === 'Сохранить неполный'), 7000);
    assert.equal(failedCalls, 3);
    [...controls.actions.querySelectorAll('button')].find((button) => button.textContent === 'Сохранить неполный').click();
    await pending;
    assert.equal(blobs.length, 1);
    const xml = await blobText(context.window, blobs[0]);
    assert.equal((xml.match(/<section id="chapter-/g) || []).length, 1);
    assert.match(controls.status.textContent, /Сохранено: 1; пропущено: 1/);

    const cancelled = setup(table(volumeRow('Том 1. Первый') + chapterRow(12, 'Глава')));
    const cancelledBlobs = captureDownloads(cancelled.window);
    let started = false;
    cancelled.window.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    });
    cancelled.api.addVolumeButtons(cancelled.document);
    cancelled.document.querySelector('.rulate-fb2-button').click();
    await waitFor(() => started);
    cancelled.document.querySelector('.rulate-fb2-button').closest('td').querySelector('button.btn-warning').click();
    await waitFor(() => cancelled.document.querySelector('[role="status"]').textContent.includes('отменена'));
    assert.equal(cancelledBlobs.length, 0);
});

test('reports an inaccessible chapter without inserting an access page into the FB2', async () => {
    const html = table(volumeRow('Том 1. Первый') + chapterRow(12, 'Открытая') + chapterRow(13, 'Закрытая'));
    const { window, document, api } = setup(html);
    const blobs = captureDownloads(window);
    window.fetch = async (url) => response(url.includes('/13/') ? '<h1>Доступ запрещён</h1>' : chapterHtml('12'), url);
    api.addVolumeButtons(document);
    document.querySelector('.rulate-fb2-button').click();
    await waitFor(() => blobs.length === 1);
    const xml = await blobText(window, blobs[0]);
    assert.equal((xml.match(/<section id="chapter-/g) || []).length, 1);
    assert.doesNotMatch(xml, /Доступ запрещён/);
    assert.match(document.querySelector('[role="status"]').textContent, /пропущено: 1/);
});

test('stops on unexpected markup and keeps a book readable when an illustration fails', async () => {
    const markup = table(volumeRow('Том 1. Первый') + chapterRow(12, 'Глава'));
    const failed = setup(markup);
    const failedBlobs = captureDownloads(failed.window);
    failed.window.fetch = async (url) => response('<h1>Новая разметка</h1>', url);
    failed.api.addVolumeButtons(failed.document);
    failed.document.querySelector('.rulate-fb2-button').click();
    await waitFor(() => failed.document.querySelector('[role="status"]').textContent.includes('Файл не создан'));
    assert.equal(failedBlobs.length, 0);

    const images = setup(markup);
    const blobs = captureDownloads(images.window);
    images.window.fetch = async (url) => response(chapterHtml('12', '<p>Текст и <img src="https://i.imgur.com/missing.jpg">.</p>'), url);
    let requestedAnonymously = false;
    images.window.GM_xmlhttpRequest = (options) => {
        requestedAnonymously = options.anonymous;
        queueMicrotask(() => options.onerror());
        return { abort: () => options.onabort() };
    };
    images.api.addVolumeButtons(images.document);
    images.document.querySelector('.rulate-fb2-button').click();
    await waitFor(() => blobs.length === 1);
    const xml = await blobText(images.window, blobs[0]);
    assert.equal(requestedAnonymously, true);
    assert.match(xml, /Иллюстрация недоступна/);
    assert.match(images.document.querySelector('[role="status"]').textContent, /изображений не загружено: 1/);
});
