// ============================================================
// WB Drive · Прототип «Запрос выгрузки» (магистраль, склад → склад)
//
// Задача от бизнеса: на онлайн-табло портала логистики нужен новый
// статус «Запрос выгрузки», чтобы склад заранее готовил ворота.
//
// Ключевое наблюдение: водители жмут «Я на месте», уже стоя у ворот
// рядом с сотрудником склада, — кнопка по факту выдаёт QR, а не
// отмечает прибытие. Поэтому любой триггер на этой кнопке приходит
// складу тогда, когда готовить ворота поздно.
//
// Четыре варианта триггера:
//   А — тап «Я на месте», метод летит фоном (предложение бизнеса)
//   Б — то же, но с шитом-подтверждением ДО отметки прибытия
//   В — геофенс: лестница рубежей 20/5/1 км, запрос уходит сам
//   Г — событие считается на сервере по ETA из GPS-трека
//
// Табло справа показывает то, ради чего всё затевается: за сколько
// минут до прибытия склад узнал о машине.
// ============================================================

(function () {
    'use strict';

    const TRIP = {
        title: 'Разгрузка №256352',
        order: 'Заявка 4765',
        point: 'Точка 1',
        address: 'МО, д. Ближние Прудищи, 2/1',
        tara: 'Тара 52 шт',
        gate: 'Ворота 25',
        timer: '02:10:40',
    };

    // Дорога до склада. km — расстояние, lead — сколько минут форы
    // получит склад, если узнает о машине в этой точке.
    const ROAD = [
        { id: 'route', km: 40, lead: 35, label: '40 км до склада' },
        { id: 'far',   km: 20, lead: 18, label: '20 км до склада' },
        { id: 'mid',   km: 5,  lead: 6,  label: '5 км до склада' },
        { id: 'near',  km: 1,  lead: 2,  label: '1 км до склада' },
        { id: 'gate',  km: 0,  lead: 0,  label: 'у ворот склада' },
    ];

    const VARIANTS = [
        { id: 'a', label: 'А · тап у ворот' },
        { id: 'b', label: 'Б · шит у ворот' },
        { id: 'c', label: 'В · геофенс' },
        { id: 'd', label: 'Г · сервер по ETA' },
    ];

    const ANSWERS = [
        { id: 'ok', label: 'Успех' },
        { id: 'error', label: 'Ошибка' },
    ];

    // dead — с какого расстояния до склада пропадает мобильный интернет.
    // GPS при этом работает: он со спутников и сети не требует.
    const SIGNALS = [
        { id: 0, label: 'Есть везде' },
        { id: 5, label: 'Нет ближе 5 км' },
        { id: 30, label: 'Нет ближе 30 км' },
    ];

    const QR_LOAD_MS = 900;
    const REQUEST_MS = 1400;
    const AUTO_RETRY_MS = 4000;

    const state = {
        variant: 'a',
        answer: 'ok',
        dead: 0,
        posIdx: 0,
        screen: 'point',   // 'point' | 'loading' | 'qr'
        sheetOpen: false,
        sheetShown: false,
        arrived: false,
        qrShown: false,
        req: 'idle',       // что знает телефон: 'idle'|'sending'|'ok'|'failed'|'queued'
        // Табло портала логистики
        boardRequested: false,
        boardLead: null,
        boardLate: false,
        boardAtGate: false,
    };

    const screenEl = document.getElementById('screen');
    const boardEl = document.getElementById('urBoard');
    let requestTimer = null;
    let retryTimer = null;
    let loadTimer = null;

    function icon(id, size) {
        const s = size || 24;
        return `<svg width="${s}" height="${s}" aria-hidden="true"><use href="#${id}"/></svg>`;
    }

    function pos() {
        return ROAD[state.posIdx];
    }

    // Мобильный интернет. GPS отдельно — он есть всегда.
    function hasSignal() {
        return state.dead === 0 || pos().km > state.dead;
    }

    // ============================================================
    // Табло портала логистики
    // ============================================================
    function registerBoard() {
        if (state.boardRequested) return;
        state.boardRequested = true;
        state.boardLead = pos().lead;
        state.boardLate = pos().km === 0 || state.qrShown;
    }

    // ============================================================
    // Вызов метода «Запрос выгрузки»
    // fromServer — событие сформировал бэкенд по ETA (вариант Г),
    // телефон в этом случае только получает номер ворот.
    // ============================================================
    function attemptRequest(fromServer) {
        clearTimeout(requestTimer);
        clearTimeout(retryTimer);

        if (!hasSignal()) {
            // Запрос не теряем: кладём в очередь и доотправляем,
            // когда появится связь. Водителя не блокируем.
            if (!fromServer) {
                state.req = 'queued';
                render();
            }
            return;
        }

        state.req = 'sending';
        render();

        requestTimer = setTimeout(function () {
            if (state.answer === 'error') {
                state.req = 'failed';
                if (!fromServer) registerBoard();
                render();
                retryTimer = setTimeout(function () { attemptRequest(fromServer); }, AUTO_RETRY_MS);
                return;
            }
            state.req = 'ok';
            if (!fromServer) registerBoard();
            render();
        }, REQUEST_MS);
    }

    function goToQr() {
        state.screen = 'loading';
        render();
        clearTimeout(loadTimer);
        loadTimer = setTimeout(function () {
            state.screen = 'qr';
            render();
        }, QR_LOAD_MS);
    }

    function confirmArrival() {
        state.arrived = true;
        goToQr();
        attemptRequest(false);
    }

    // Проехали следующий рубеж. В варианте В здесь срабатывает
    // геофенс, в Г — бэкенд сам ставит статус по ETA.
    function advance() {
        if (state.posIdx >= ROAD.length - 1) return;
        state.posIdx += 1;
        const p = pos();

        if (state.variant === 'c' && p.id !== 'route' && state.req !== 'ok') {
            attemptRequest(false);
        } else if (state.variant === 'd') {
            // Бэкенд считает ETA по последней принятой точке трека,
            // поэтому статус встаёт на табло даже если телефон уже
            // в мёртвой зоне. Номер ворот доедет до водителя позже.
            if (p.km <= 20) registerBoard();
            if (state.boardRequested && state.req !== 'ok') attemptRequest(true);
        }
        render();
    }

    // ============================================================
    // Bottom sheet (вариант Б)
    // ============================================================
    function openSheet() {
        state.sheetOpen = true;
        state.sheetShown = false;
        render();
        requestAnimationFrame(function () {
            state.sheetShown = true;
            const sheet = document.getElementById('urSheet');
            const backdrop = document.getElementById('urBackdrop');
            if (sheet) sheet.classList.add('is-open');
            if (backdrop) backdrop.classList.add('is-open');
        });
    }

    function closeSheet(after) {
        const sheet = document.getElementById('urSheet');
        const backdrop = document.getElementById('urBackdrop');
        if (sheet) sheet.classList.remove('is-open');
        if (backdrop) backdrop.classList.remove('is-open');
        setTimeout(function () {
            state.sheetOpen = false;
            state.sheetShown = false;
            if (after) after();
            else render();
        }, 260);
    }

    // ============================================================
    // Действия на экране
    // ============================================================
    const ACTIONS = {
        arrive: function () {
            if (state.variant === 'b') openSheet();
            else confirmArrival();
        },
        sheetConfirm: function () {
            closeSheet(confirmArrival);
        },
        sheetCancel: function () {
            // Прибытие не отмечено, запрос не отправлен — состояние
            // ровно то же, что до тапа.
            closeSheet();
        },
        // Варианты В и Г: запрос ушёл на подъезде, кнопка делает то,
        // за чем к ней и тянутся, — открывает код.
        showQr: function () {
            state.arrived = true;
            if (state.req !== 'ok') attemptRequest(state.variant === 'd');
            goToQr();
        },
        back: function () {
            state.screen = 'point';
            render();
        },
        qrShown: function () {
            state.qrShown = true;
            state.boardAtGate = true;
            state.screen = 'point';
            render();
        },
        retry: function () {
            attemptRequest(false);
        },
        noop: function () {},
    };

    screenEl.addEventListener('click', function (e) {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.getAttribute('data-act');
        if (ACTIONS[act]) ACTIONS[act]();
    });

    // ============================================================
    // Блоки экрана
    // ============================================================
    function statusbar() {
        const wifi = hasSignal()
            ? `<svg width="17" height="13" viewBox="0 0 18 14" aria-hidden="true"><use href="#i-sb-wifi"/></svg>`
            : `<span class="is-off">${icon('i-wifi-off', 16)}</span>`;
        return `
            <div class="ur-statusbar">
                <span class="ur-statusbar__time">12:30</span>
                <span class="ur-statusbar__icons">
                    ${wifi}
                    <svg width="17" height="13" viewBox="0 0 18 14" aria-hidden="true"><use href="#i-sb-signal"/></svg>
                    <svg width="11" height="15" viewBox="0 0 12 16" aria-hidden="true"><use href="#i-sb-battery"/></svg>
                </span>
            </div>`;
    }

    function head(withBack) {
        return `
            <div class="ur-head">
                ${withBack ? `<button class="ur-head__back" data-act="back" aria-label="Назад">${icon('i-back', 26)}</button>` : ''}
                <div class="ur-head__title">${TRIP.title}</div>
                <div class="ur-head__sub">${TRIP.order}</div>
            </div>`;
    }

    function topRow() {
        const running = !state.arrived;
        return `
            <div class="ur-toprow">
                <div class="ur-timer ${running ? 'is-running' : ''}">
                    <div class="ur-timer__val">${TRIP.timer}</div>
                    <div class="ur-timer__cap">${running ? 'До завершения маршрута' : 'Таймер остановлен'}</div>
                </div>
                <div class="ur-ttn">
                    <div>
                        <div class="ur-ttn__title">ТН</div>
                        <div class="ur-ttn__sub">PDF</div>
                    </div>
                    <span class="ur-ttn__dl">${icon('i-download', 22)}</span>
                </div>
            </div>`;
    }

    // Обратная связь у ворот (варианты А и Б). Оставлена намеренно:
    // на демонстрации видно, что при позднем триггере мы сообщаем
    // водителю то, что он и так уже знает.
    function statusRow(compact) {
        const cls = compact ? ' ur-status--compact' : '';
        if (state.req === 'sending') {
            return `<div class="ur-status ur-status--sending${cls}">
                <span class="ur-spin"></span>
                <span>Запрашиваем разгрузку у склада…</span>
            </div>`;
        }
        if (state.req === 'ok') {
            return `<div class="ur-status ur-status--ok${cls}">
                ${icon('i-check-circle', 20)}
                <span>Склад видит вас в очереди на разгрузку</span>
            </div>`;
        }
        if (state.req === 'failed') {
            return `<div class="ur-status ur-status--warn${cls}">
                ${icon('i-alert', 20)}
                <span>Склад пока не уведомлён, повторяем</span>
                <button class="ur-status__retry" data-act="retry">Повторить</button>
            </div>`;
        }
        if (state.req === 'queued') {
            return `<div class="ur-status ur-status--warn${cls}">
                ${icon('i-wifi-off', 20)}
                <span>Нет сети. Отправим запрос, как появится связь</span>
            </div>`;
        }
        return '';
    }

    // Варианты В и Г: что водитель видит на подъезде. Здесь обратная
    // связь уместна — он едет и реально ждёт номер ворот.
    function approachBlock() {
        if (state.req === 'sending') {
            return `<div class="ur-approach ur-approach--wait">
                <span class="ur-spin"></span>
                <span>Запросили разгрузку. Ждём номер ворот</span>
            </div>`;
        }
        if (state.req === 'ok') {
            return `<div class="ur-approach ur-approach--ok">
                <div class="ur-approach__cap">Склад ждёт вас</div>
                <div class="ur-approach__gate">${TRIP.gate}</div>
            </div>`;
        }
        if (state.req === 'queued') {
            return `<div class="ur-approach ur-approach--soft">
                ${icon('i-wifi-off', 20)}
                <span>Нет сети. Запросим разгрузку, как появится связь</span>
            </div>`;
        }
        // Ошибку метода водителю знать незачем: он её не починит.
        return `<div class="ur-approach ur-approach--soft">
            ${icon('i-alert', 20)}
            <span>Ворота назначит сотрудник склада на месте</span>
        </div>`;
    }

    // Ворота приходят в ответ на «Запрос выгрузки» — пока ответа нет,
    // номера ворот нет тоже.
    function gateLabel() {
        if (state.req === 'ok') return `<div class="ur-card__gate">${TRIP.gate}</div>`;
        if (state.req === 'sending') return `<div class="ur-card__gate is-muted">Ждём номер ворот…</div>`;
        return `<div class="ur-card__gate is-muted">Ворота — у сотрудника склада</div>`;
    }

    function bottomBar(inner) {
        return `<div class="ur-bottom">${inner}</div>`;
    }

    function tabbar() {
        return `
            <nav class="ur-tabbar">
                <span class="ur-tabbar__item is-active">${icon('i-briefcase', 26)}</span>
                <span class="ur-tabbar__item">${icon('i-chat', 26)}</span>
                <span class="ur-tabbar__item">${icon('i-profile-tab', 26)}</span>
                <span class="ur-home"></span>
            </nav>`;
    }

    // Детерминированный псевдо-QR, чтобы картинка не «прыгала»
    // между рендерами.
    function qrSvg() {
        const N = 25;
        let seed = 20250729;
        function rnd() {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        }
        function isFinderZone(x, y) {
            return (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
        }
        function finder(ox, oy) {
            return `<rect x="${ox}" y="${oy}" width="7" height="7"/>` +
                `<rect x="${ox + 1}" y="${oy + 1}" width="5" height="5" fill="#fff"/>` +
                `<rect x="${ox + 2}" y="${oy + 2}" width="3" height="3"/>`;
        }
        const cells = [];
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                if (isFinderZone(x, y)) continue;
                if (rnd() > 0.47) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
            }
        }
        return `<svg class="ur-qr" width="100%" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges" fill="#18181b" role="img" aria-label="QR-код для сотрудника склада">
            ${finder(0, 0)}${finder(N - 7, 0)}${finder(0, N - 7)}${cells.join('')}
        </svg>`;
    }

    // ============================================================
    // Экраны
    // ============================================================
    function renderPointScreen() {
        const geoVariant = state.variant === 'c' || state.variant === 'd';
        const onApproach = geoVariant && !state.arrived && state.req !== 'idle';

        let ctaLabel = 'Я на месте';
        let ctaAct = 'arrive';
        if (state.arrived) {
            ctaLabel = 'Разгрузить';
            ctaAct = 'noop';
        } else if (onApproach) {
            ctaLabel = 'Показать QR';
            ctaAct = 'showQr';
        }

        let feedback = '';
        if (onApproach) feedback = approachBlock();
        else if (state.arrived && !geoVariant) feedback = statusRow(true);

        return `
            ${statusbar()}
            ${head(false)}
            <div class="ur-body">
                ${topRow()}
                <div class="ur-card">
                    <div class="ur-card__title">${TRIP.point}</div>
                    <div class="ur-row">${icon('i-warehouse')}<span>${TRIP.address}</span></div>
                    <div class="ur-row">${icon('i-crate')}<span>${TRIP.tara}</span></div>
                    ${feedback}
                    <button class="ur-cta" data-act="${ctaAct}">${ctaLabel}</button>
                </div>
            </div>
            ${bottomBar(`
                <button class="ur-refresh" aria-label="Обновить">${icon('i-refresh', 24)}</button>
                <button class="ur-primary ${state.arrived ? '' : 'is-disabled'}">Завершить поездку</button>
            `)}
            ${tabbar()}`;
    }

    function renderLoadingScreen() {
        return `
            ${statusbar()}
            ${head(false)}
            <div class="ur-body">
                <div class="ur-card">
                    <div class="ur-sk ur-sk--pill"></div>
                    <div class="ur-sk ur-sk--qr"></div>
                    <div class="ur-sk ur-sk--hint"></div>
                    <div class="ur-sk-row">
                        <div class="ur-sk ur-sk--dot"></div>
                        <div class="ur-sk ur-sk--line"></div>
                    </div>
                    <div class="ur-sk-row">
                        <div class="ur-sk ur-sk--dot"></div>
                        <div class="ur-sk ur-sk--line"></div>
                    </div>
                </div>
            </div>
            ${bottomBar('<div class="ur-sk ur-sk--btn"></div>')}
            ${tabbar()}`;
    }

    function renderQrScreen() {
        const geoVariant = state.variant === 'c' || state.variant === 'd';
        return `
            ${statusbar()}
            ${head(true)}
            <div class="ur-body">
                <div class="ur-card">
                    ${gateLabel()}
                    ${qrSvg()}
                    <div class="ur-hint">${icon('i-info-filled', 22)}<span>Покажите QR-код сотруднику склада</span></div>
                    ${geoVariant ? '' : statusRow(false)}
                    <div class="ur-row">${icon('i-warehouse')}<span>${TRIP.address}</span></div>
                    <div class="ur-row">${icon('i-crate')}<span>${TRIP.tara}</span></div>
                </div>
            </div>
            ${bottomBar('<button class="ur-primary" data-act="qrShown">QR-код показан</button>')}
            ${tabbar()}`;
    }

    function renderSheet() {
        if (!state.sheetOpen) return '';
        const openCls = state.sheetShown ? ' is-open' : '';
        return `
            <div class="ur-backdrop${openCls}" id="urBackdrop" data-act="sheetCancel"></div>
            <div class="ur-sheet${openCls}" id="urSheet" role="dialog" aria-label="Запросить разгрузку">
                <div class="ur-sheet__handle"></div>
                <div class="ur-sheet__title">Запросить разгрузку?</div>
                <div class="ur-sheet__text">Склад увидит, что машина готова к разгрузке, и назначит ворота.</div>
                <button class="ur-sheet__primary" data-act="sheetConfirm">Да, я готов</button>
                <button class="ur-sheet__cancel" data-act="sheetCancel">Нет</button>
            </div>`;
    }

    // ============================================================
    // Табло портала логистики (десктоп, справа от телефона)
    // ============================================================
    function renderBoard() {
        let chipCls = 'is-idle';
        let chipText = 'В пути';
        let note = 'Склад не знает, что машина подъезжает';

        if (state.boardRequested) {
            chipCls = 'is-req';
            chipText = 'Запрос выгрузки';
            note = state.boardLate
                ? 'Машина уже у ворот — готовиться некогда'
                : `Склад узнал за ${state.boardLead} мин до прибытия`;
        }
        if (state.boardAtGate) {
            chipCls = 'is-gate';
            chipText = 'Машина на воротах';
            note = state.boardRequested
                ? (state.boardLead > 0 ? `Запрос выгрузки пришёл за ${state.boardLead} мин` : 'Запрос выгрузки пришёл в последний момент')
                : 'Запроса выгрузки так и не было';
        }

        boardEl.innerHTML = `
            <div class="ur-board__title">Табло портала логистики</div>
            <div class="ur-board__trip">Рейс 256352 · магистраль</div>
            <div class="ur-board__chip ${chipCls}">${chipText}</div>
            <div class="ur-board__note">${note}</div>
            <div class="ur-board__sep"></div>
            <div class="ur-board__row"><span>Машина</span><b>${pos().label}</b></div>
            <div class="ur-board__row"><span>Интернет</span><b class="${hasSignal() ? '' : 'is-bad'}">${hasSignal() ? 'есть' : 'нет'}</b></div>
            <div class="ur-board__row"><span>GPS</span><b>есть</b></div>`;
    }

    function render() {
        let body;
        if (state.screen === 'loading') body = renderLoadingScreen();
        else if (state.screen === 'qr') body = renderQrScreen();
        else body = renderPointScreen();

        screenEl.innerHTML = `<div class="ur-screen">${body}${renderSheet()}</div>`;
        renderBoard();
        renderDemo();
    }

    // ============================================================
    // Демо-панель
    // ============================================================
    function resetFlow() {
        clearTimeout(requestTimer);
        clearTimeout(retryTimer);
        clearTimeout(loadTimer);
        state.posIdx = 0;
        state.screen = 'point';
        state.sheetOpen = false;
        state.sheetShown = false;
        state.arrived = false;
        state.qrShown = false;
        state.req = 'idle';
        state.boardRequested = false;
        state.boardLead = null;
        state.boardLate = false;
        state.boardAtGate = false;
    }

    function renderDemo() {
        const variantWrap = document.getElementById('urVariantBtns');
        const answerWrap = document.getElementById('urNetBtns');
        const signalWrap = document.getElementById('urSignalBtns');
        const actionWrap = document.getElementById('urActionBtns');

        variantWrap.innerHTML = VARIANTS.map(function (v) {
            return `<button class="ur-demo__btn${v.id === state.variant ? ' is-active' : ''}" data-variant="${v.id}">${v.label}</button>`;
        }).join('');

        answerWrap.innerHTML = ANSWERS.map(function (a) {
            return `<button class="ur-demo__btn${a.id === state.answer ? ' is-active' : ''}" data-answer="${a.id}">${a.label}</button>`;
        }).join('');

        signalWrap.innerHTML = SIGNALS.map(function (s) {
            return `<button class="ur-demo__btn${s.id === state.dead ? ' is-active' : ''}" data-signal="${s.id}">${s.label}</button>`;
        }).join('');

        const next = ROAD[state.posIdx + 1];
        const canDrive = !!next && !state.arrived;
        const canFlush = (state.req === 'queued' || state.req === 'failed') && state.dead !== 0;
        actionWrap.innerHTML =
            `<button class="ur-demo__btn is-ghost" data-drive="1"${canDrive ? '' : ' disabled'}>Проехать: ${next ? next.label : 'приехали'}</button>` +
            `<button class="ur-demo__btn is-ghost" data-flush="1"${canFlush ? '' : ' disabled'}>Связь вернулась</button>` +
            `<button class="ur-demo__btn is-ghost" data-reset="1">Сброс</button>`;

        variantWrap.querySelectorAll('[data-variant]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.variant = btn.getAttribute('data-variant');
                resetFlow();
                render();
            });
        });
        answerWrap.querySelectorAll('[data-answer]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.answer = btn.getAttribute('data-answer');
                render();
            });
        });
        signalWrap.querySelectorAll('[data-signal]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.dead = parseInt(btn.getAttribute('data-signal'), 10);
                resetFlow();
                render();
            });
        });
        actionWrap.querySelector('[data-drive]').addEventListener('click', advance);
        actionWrap.querySelector('[data-flush]').addEventListener('click', function () {
            state.dead = 0;
            attemptRequest(false);
        });
        actionWrap.querySelector('[data-reset]').addEventListener('click', function () {
            resetFlow();
            render();
        });
    }

    render();
})();
