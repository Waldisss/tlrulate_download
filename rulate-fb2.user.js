// ==UserScript==
// @name         Rulate: тома в FB2
// @namespace    https://github.com/Waldisss/tlrulate_download
// @version      1.1.1
// @description  Собирает доступные для чтения главы тома в FB2 с иллюстрациями.
// @match        https://tl.rulate.ru/book/*
// @grant        GM_xmlhttpRequest
// @connect      tl.rulate.ru
// @connect      i.imgur.com
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const BOOK_ID = location.pathname.match(/^\/book\/(\d+)\/?$/)?.[1] || '';
    const BOOK_URL = BOOK_ID ? `${location.origin}/book/${BOOK_ID}` : location.href;
    const MIN_REQUEST_INTERVAL_MS = 1000;
    const REQUEST_TIMEOUT_MS = 30000;
    const TRANSIENT_RETRIES = 2;
    const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';
    const state = { activeJob: null, lastChapterRequestAt: 0 };

    class AccessDeniedError extends Error {}
    class TransientRequestError extends Error {}
    class UnknownChapterError extends Error {}
    class CancelledError extends Error {}

    function cleanText(value) {
        return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function escapeXml(value) {
        return String(value)
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function safeFilePart(value) {
        return cleanText(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 140);
    }

    function getBookTitle(doc) {
        return cleanText(doc.querySelector('h1')?.textContent)
            || cleanText(doc.querySelector('meta[property="og:title"]')?.content)
            || 'Произведение';
    }

    function chapterUrl(href) {
        try {
            const url = new URL(href, BOOK_URL);
            const match = url.pathname.match(/^\/book\/(\d+)\/(\d+)\/ready(?:_new)?\/?$/);
            if (url.origin !== location.origin || !match || match[1] !== BOOK_ID) return null;
            return { id: match[2], url: url.origin + url.pathname };
        } catch (_) {
            return null;
        }
    }

    function getVolumes(doc) {
        const table = doc.querySelector('#Chapters');
        if (!table) return [];
        const volumes = [];
        let volume = null;
        for (const row of table.querySelectorAll('tr')) {
            if (row.classList.contains('volume_helper')) {
                volume = null;
                const strong = row.querySelector('strong');
                if (strong && cleanText(strong.textContent)) {
                    volume = {
                        title: cleanText(strong.textContent),
                        row,
                        chapters: [],
                    };
                    volumes.push(volume);
                }
                continue;
            }
            if (!volume || !row.classList.contains('chapter_row')) continue;
            const titleLink = row.querySelector('td.t a[href]');
            const readLink = [...row.querySelectorAll('a[href]')]
                .find((a) => cleanText(a.textContent).toLowerCase() === 'читать'
                    && a.closest('td') !== titleLink?.closest('td'));
            const target = readLink && chapterUrl(readLink.href);
            if (target) {
                volume.chapters.push({ ...target, title: cleanText(titleLink?.textContent) || `Глава ${target.id}` });
            }
        }
        for (const item of volumes) {
            const unique = new Set();
            item.chapters = item.chapters.filter((chapter) => {
                if (unique.has(chapter.id)) return false;
                unique.add(chapter.id);
                return true;
            });
        }
        return volumes;
    }

    function allChaptersVisible(doc) {
        const select = doc.querySelector('select[name="c_countOnPage"]');
        return Boolean(select && select.value === '0');
    }

    function isDeniedPage(doc, responseUrl) {
        const heading = cleanText(doc.querySelector('h1')?.textContent).toLowerCase();
        const path = new URL(responseUrl, BOOK_URL).pathname;
        return heading.includes('доступ запрещ') || heading.includes('нет доступа')
            || /^\/(?:login|site\/login|users\/login|auth)(?:\/|$)/i.test(path)
            || Boolean(doc.querySelector('form[action*="/login"]'));
    }

    function parseChapterHtml(html, expectedId, responseUrl) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (isDeniedPage(doc, responseUrl)) throw new AccessDeniedError('Глава недоступна для чтения');
        const root = doc.querySelector(`[id="scroll_chapter_${expectedId}"] .content-text`);
        if (!root || !cleanText(root.textContent) && !root.querySelector('img')) {
            throw new UnknownChapterError('Не удалось найти текст главы в ожидаемой разметке');
        }
        return root;
    }

    function checkCancelled(job) {
        if (job.cancelled) throw new CancelledError('Выгрузка отменена');
    }

    function delay(ms, job) {
        return new Promise((resolve, reject) => {
            if (job.cancelled) return reject(new CancelledError('Выгрузка отменена'));
            const timer = setTimeout(() => {
                job.cancelDelay = null;
                resolve();
            }, ms);
            job.cancelDelay = () => {
                clearTimeout(timer);
                job.cancelDelay = null;
                reject(new CancelledError('Выгрузка отменена'));
            };
        });
    }

    async function fetchChapter(job, chapter) {
        for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
            checkCancelled(job);
            const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - state.lastChapterRequestAt);
            if (wait > 0) await delay(wait, job);
            checkCancelled(job);
            state.lastChapterRequestAt = Date.now();
            const controller = new AbortController();
            job.activeController = controller;
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await fetch(chapter.url, {
                    method: 'GET', credentials: 'include', redirect: 'follow', signal: controller.signal,
                });
                if (response.status === 401 || response.status === 403) {
                    throw new AccessDeniedError('Глава недоступна для чтения');
                }
                if (response.status === 429 || response.status >= 500) {
                    throw new TransientRequestError(`Сервер ответил ${response.status}`);
                }
                if (!response.ok) throw new UnknownChapterError(`Сервер ответил ${response.status}`);
                const html = await response.text();
                return parseChapterHtml(html, chapter.id, response.url || chapter.url);
            } catch (error) {
                if (job.cancelled) throw new CancelledError('Выгрузка отменена');
                const transient = error instanceof TransientRequestError
                    || error.name === 'AbortError' || error instanceof TypeError;
                if (!transient) throw error;
                if (attempt === TRANSIENT_RETRIES) {
                    throw new TransientRequestError(`Глава «${chapter.title}»: ${error.message}`);
                }
            } finally {
                clearTimeout(timeout);
                if (job.activeController === controller) job.activeController = null;
            }
        }
        throw new TransientRequestError('Не удалось получить главу');
    }

    function imageUrl(value, pageUrl) {
        try {
            const url = new URL(value, pageUrl);
            const host = url.hostname.toLowerCase();
            if (url.protocol !== 'https:' || !['tl.rulate.ru', 'i.imgur.com'].includes(host)) return null;
            url.hash = '';
            return url.href;
        } catch (_) {
            return null;
        }
    }

    function imageMime(bytes) {
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
        if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a') return 'image/gif';
        if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a') return 'image/gif';
        return null;
    }

    function base64(bytes) {
        const parts = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
            parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
        }
        return btoa(parts.join(''));
    }

    function requestImage(job, url) {
        return new Promise((resolve, reject) => {
            if (job.cancelled) return reject(new CancelledError('Выгрузка отменена'));
            const request = GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT_MS,
                anonymous: new URL(url).hostname !== 'tl.rulate.ru',
                onload: (response) => {
                    job.activeImageRequest = null;
                    if (job.cancelled) return reject(new CancelledError('Выгрузка отменена'));
                    if (response.status < 200 || response.status >= 300
                        || !response.response || typeof response.response.byteLength !== 'number') {
                        return reject(new Error(`Не удалось загрузить изображение: ${response.status}`));
                    }
                    const bytes = new Uint8Array(response.response);
                    const mime = imageMime(bytes);
                    if (!mime) return reject(new Error('Неподдерживаемый формат изображения'));
                    resolve({ mime, data: base64(bytes) });
                },
                onerror: () => {
                    job.activeImageRequest = null;
                    reject(new Error('Ошибка сети при загрузке изображения'));
                },
                ontimeout: () => {
                    job.activeImageRequest = null;
                    reject(new Error('Превышено время загрузки изображения'));
                },
                onabort: () => {
                    job.activeImageRequest = null;
                    reject(new CancelledError('Выгрузка отменена'));
                },
            });
            job.activeImageRequest = request;
        });
    }

    async function getImage(job, rawUrl, pageUrl) {
        const url = imageUrl(rawUrl, pageUrl);
        if (!url) {
            job.failedImages++;
            return null;
        }
        if (!job.images.has(url)) {
            const loading = requestImage(job, url).then((image) => {
                const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' }[image.mime];
                return { ...image, id: `image-${job.images.size}.${ext}` };
            }).catch((error) => {
                if (error instanceof CancelledError || job.cancelled) throw error;
                job.failedImages++;
                return null;
            });
            job.images.set(url, loading);
        }
        return job.images.get(url);
    }

    async function renderInline(node, job, pageUrl) {
        if (node.nodeType === Node.TEXT_NODE) return escapeXml(node.nodeValue.replace(/\s+/g, ' '));
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const name = node.localName.toLowerCase();
        if (['script', 'style', 'noscript', 'button', 'form'].includes(name)
            || node.hasAttribute('hidden') || /display\s*:\s*none/i.test(node.getAttribute('style') || '')) return '';
        if (name === 'br') return ' ';
        if (name === 'img') {
            const image = await getImage(job, node.getAttribute('src'), pageUrl);
            return image ? `<image l:href="#${image.id}"/>` : escapeXml('[Иллюстрация недоступна]');
        }
        const children = [];
        for (const child of node.childNodes) children.push(await renderInline(child, job, pageUrl));
        const content = children.join('');
        if (!content) return '';
        if (name === 'a') {
            try {
                const href = new URL(node.getAttribute('href') || '', pageUrl);
                if (['https:', 'http:'].includes(href.protocol)) return `<a l:href="${escapeXml(href.href)}">${content}</a>`;
            } catch (_) { /* Invalid links remain plain text. */ }
        }
        const style = node.getAttribute('style') || '';
        const bold = ['b', 'strong'].includes(name) || /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style);
        const italic = ['i', 'em'].includes(name) || /font-style\s*:\s*italic/i.test(style);
        let result = content;
        if (italic) result = `<emphasis>${result}</emphasis>`;
        if (bold) result = `<strong>${result}</strong>`;
        return result;
    }

    async function renderBlocks(root, job, pageUrl) {
        const output = [];
        async function visit(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                if (cleanText(node.nodeValue)) output.push(`<p>${escapeXml(cleanText(node.nodeValue))}</p>`);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const name = node.localName.toLowerCase();
            if (['script', 'style', 'noscript', 'button', 'form'].includes(name)
                || node.hasAttribute('hidden') || /display\s*:\s*none/i.test(node.getAttribute('style') || '')) return;
            if (['p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'li'].includes(name)) {
                const content = await renderInline(node, job, pageUrl);
                output.push(cleanText(node.textContent) || node.querySelector('img')
                    ? `<p>${content}</p>` : '<empty-line/>');
                return;
            }
            if (name === 'img') {
                output.push(`<p>${await renderInline(node, job, pageUrl)}</p>`);
                return;
            }
            for (const child of node.childNodes) await visit(child);
        }
        for (const node of root.childNodes) await visit(node);

        const emptyLine = '<empty-line/>';
        const solidCount = output.filter((block) => block !== emptyLine).length;
        const gapCounts = new Map();
        for (let i = 0; i < output.length;) {
            if (output[i] !== emptyLine) { i++; continue; }
            let end = i + 1;
            while (output[end] === emptyLine) end++;
            if (i > 0 && end < output.length) {
                const length = end - i;
                gapCounts.set(length, (gapCounts.get(length) || 0) + 1);
            }
            i = end;
        }
        const [commonGap, occurrences] = [...gapCounts]
            .sort((a, b) => b[1] - a[1])[0] || [0, 0];
        const routineGap = solidCount >= 6 && occurrences >= 3
            && occurrences / (solidCount - 1) >= 0.6 ? commonGap : 0;

        const normalized = [];
        for (let i = 0; i < output.length;) {
            if (output[i] !== emptyLine) {
                normalized.push(output[i++]);
                continue;
            }
            let end = i + 1;
            while (output[end] === emptyLine) end++;
            if (i > 0 && end < output.length && end - i > routineGap) normalized.push(emptyLine);
            i = end;
        }
        return normalized.join('\n');
    }

    function buildFb2(volume, chapters, images, cover, meta) {
        const title = `${meta.bookTitle || 'Произведение'} — ${volume.title}`;
        const date = new Date().toISOString().slice(0, 10);
        const volumeId = volume.row?.id?.match(/^vol_title_(\d+)$/)?.[1]
            || volume.chapters?.[0]?.id || chapters[0].id;
        const description = [
            '<description><title-info>',
            '<genre>unrecognised</genre>',
            `<author><nickname>${escapeXml(meta.author || 'Неизвестный автор')}</nickname></author>`,
            `<book-title>${escapeXml(title)}</book-title>`,
            cover ? `<coverpage><image l:href="#${cover.id}"/></coverpage>` : '',
            '<lang>ru</lang>',
            '</title-info><document-info>',
            '<author><nickname>Rulate FB2 Export</nickname></author>',
            '<program-used>Rulate FB2 Export</program-used>',
            `<date value="${date}">${date}</date>`,
            `<src-url>${escapeXml(BOOK_URL)}</src-url>`,
            `<id>rulate-${BOOK_ID}-volume-${volumeId}</id>`,
            '<version>1.0</version>',
            '</document-info></description>',
        ].join('');
        const sections = chapters.map((chapter) =>
            `<section id="chapter-${chapter.id}"><title><p>${escapeXml(chapter.title)}</p></title>\n${chapter.body}</section>`).join('\n');
        const binaries = [...images.values()].filter((image) => image && image.data).map((image) =>
            `<binary id="${image.id}" content-type="${image.mime}">${image.data}</binary>`).join('\n');
        return `<?xml version="1.0" encoding="UTF-8"?>\n`
            + `<FictionBook xmlns="${FB2_NS}" xmlns:l="${XLINK_NS}">\n`
            + `${description}\n<body><title><p>${escapeXml(title)}</p></title>\n${sections}</body>\n${binaries}</FictionBook>`;
    }

    function saveFile(xml, filename) {
        const blob = new Blob([xml], { type: 'application/xml;charset=UTF-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function setStatus(job, message) {
        job.status.textContent = message;
    }

    function finishJob(job, message) {
        job.cancelButton.hidden = true;
        job.actions.replaceChildren();
        setStatus(job, message);
        state.activeJob = null;
        for (const button of document.querySelectorAll('.rulate-fb2-button')) button.disabled = false;
    }

    function cancelJob(job) {
        job.cancelled = true;
        job.activeController?.abort();
        job.activeImageRequest?.abort();
        job.cancelDelay?.();
        job.resolvePause?.('cancel');
    }

    function pauseForError(job, message) {
        setStatus(job, message);
        return new Promise((resolve) => {
            const options = [
                ['Повторить', 'retry'],
                ['Сохранить неполный', 'partial'],
                ['Отмена', 'cancel'],
            ];
            job.resolvePause = (answer) => {
                job.resolvePause = null;
                job.actions.replaceChildren();
                resolve(answer);
            };
            for (const [label, value] of options) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-small';
                button.textContent = label;
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    job.resolvePause?.(value);
                });
                job.actions.append(button);
            }
        });
    }

    async function downloadVolume(volume, controls) {
        const { status, cancelButton, actions } = controls;
        if (state.activeJob) return;
        if (!allChaptersVisible(document)) {
            status.textContent = 'Выберите «Выводить главы по: Все», затем повторите.';
            return;
        }
        if (!volume.chapters.length) {
            status.textContent = 'В этом томе нет глав с кнопкой «читать».';
            return;
        }
        const job = {
            cancelled: false, activeController: null, activeImageRequest: null,
            cancelDelay: null, resolvePause: null, status, cancelButton, actions,
            images: new Map(), failedImages: 0, chapters: [], skipped: 0,
        };
        state.activeJob = job;
        for (const button of document.querySelectorAll('.rulate-fb2-button')) button.disabled = true;
        cancelButton.hidden = false;
        const meta = {
            bookTitle: getBookTitle(document),
            author: document.querySelector('meta[property="book:author"]')?.content || '',
            coverUrl: document.querySelector('meta[property="og:image"]')?.content || '',
        };
        let incomplete = false;
        try {
            const cover = meta.coverUrl ? await getImage(job, meta.coverUrl, BOOK_URL) : null;
            for (let i = 0; i < volume.chapters.length; i++) {
                checkCancelled(job);
                const chapter = volume.chapters[i];
                setStatus(job, `${i + 1}/${volume.chapters.length}: ${chapter.title}`);
                let root;
                while (true) {
                    try {
                        root = await fetchChapter(job, chapter);
                        break;
                    } catch (error) {
                        if (error instanceof AccessDeniedError) {
                            job.skipped++;
                            break;
                        }
                        if (error instanceof CancelledError) throw error;
                        if (error instanceof UnknownChapterError) throw error;
                        const answer = await pauseForError(job, error.message);
                        if (answer === 'retry') continue;
                        if (answer === 'cancel') throw new CancelledError('Выгрузка отменена');
                        incomplete = true;
                        job.skipped += volume.chapters.length - i;
                        break;
                    }
                }
                if (incomplete) break;
                if (!root) continue;
                const body = await renderBlocks(root, job, chapter.url);
                if (!body.trim()) throw new UnknownChapterError(`Пустой текст: ${chapter.title}`);
                job.chapters.push({ ...chapter, body });
            }
            checkCancelled(job);
            if (!job.chapters.length) {
                finishJob(job, `Файл не создан: доступных глав нет. Пропущено: ${job.skipped}.`);
                return;
            }
            const resolvedImages = new Map();
            for (const [url, loading] of job.images) resolvedImages.set(url, await loading);
            const xml = buildFb2(volume, job.chapters, resolvedImages, cover, meta);
            const partial = incomplete || job.skipped > 0;
            const fileName = safeFilePart(`${meta.bookTitle} — ${volume.title}${partial ? ' (неполный)' : ''}`) + '.fb2';
            saveFile(xml, fileName);
            finishJob(job, `Сохранено: ${job.chapters.length}; пропущено: ${job.skipped}; изображений не загружено: ${job.failedImages}.`);
        } catch (error) {
            if (error instanceof CancelledError || job.cancelled) {
                finishJob(job, 'Выгрузка отменена.');
            } else {
                finishJob(job, `Ошибка: ${error.message}. Файл не создан.`);
            }
        }
    }

    function addVolumeButtons(doc) {
        for (const volume of getVolumes(doc)) {
            const cell = volume.row.cells[volume.row.cells.length - 1];
            if (!cell || cell.querySelector('.rulate-fb2-button')) continue;
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-small btn-primary rulate-fb2-button';
            button.style.marginLeft = '6px';
            button.textContent = 'Скачать том в FB2';
            const cancelButton = doc.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'btn btn-small btn-warning';
            cancelButton.style.marginLeft = '6px';
            cancelButton.textContent = 'Отмена';
            cancelButton.hidden = true;
            const status = doc.createElement('span');
            status.style.marginLeft = '6px';
            status.setAttribute('role', 'status');
            const actions = doc.createElement('span');
            actions.style.marginLeft = '6px';
            cell.append(button, cancelButton, status, actions);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                downloadVolume(volume, { status, cancelButton, actions });
            });
            cancelButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (state.activeJob) cancelJob(state.activeJob);
            });
        }
    }

    if (globalThis.__RULATE_FB2_TEST_MODE__) {
        globalThis.__RULATE_FB2_TEST_API__ = {
            getBookTitle, getVolumes, allChaptersVisible, parseChapterHtml, buildFb2, renderBlocks,
            fetchChapter, imageUrl, imageMime, addVolumeButtons, downloadVolume, cancelJob,
            errors: { AccessDeniedError, TransientRequestError, UnknownChapterError, CancelledError },
            state,
        };
    } else if (BOOK_ID && /^\/book\/\d+\/?$/.test(location.pathname)) {
        addVolumeButtons(document);
    }
})();
