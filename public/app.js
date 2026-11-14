(function () {
    'use strict';

    let sessionToken = localStorage.getItem('aris_session_token') || '';
    let authUserId = null;
    let currentUserId = null;
    let isDevAccount = false;
    let playerData = null;
    let shopCatalog = { potions: {}, modules: {}, chips: {} };
    let currentShopTab = 'potions';
    let selectedShopItemId = null;
    let inspectedProfileOverride = null;

    let terminalCmdHistory = [];
    let terminalHistoryIndex = -1;
    let previewHideTimeout = null;
    let lastKnownBshopActive = false;
    let hasCheckedInitialBshop = false;
    let suppressContextMenuUntil = 0;
    let lastRightMarqueeAt = 0;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[m]));
    }

    let lastGlobalErrToast = 0;
    function reportGlobalError(reason) {
        try { console.error('[Web OS]', reason); } catch (e) {}
        const now = Date.now();
        if (now - lastGlobalErrToast < 3000) return;
        lastGlobalErrToast = now;
        if (typeof showWinToast === 'function') {
            showWinToast('Something went wrong: ' + String((reason && reason.message) || reason || 'unknown error').slice(0, 120), 'warning', 'A.R.I.S System');
        }
    }
    window.addEventListener('unhandledrejection', (e) => reportGlobalError(e.reason));
    window.addEventListener('error', (e) => {
        if (e && typeof e.message === 'string' && e.message.includes('ResizeObserver')) return;
        reportGlobalError(e.error || e.message);
    });

    let lbState = { type: 'rolls', period: 'all', page: 1 };
    let lbNextRefreshUnix = 0;

    let nextRollTimestampMs = 0;
    let lastCdDurationMs = 10000;
    let autoRollActive = false;
    let autoRollBatchCount = 0;
    let rollHistory = [];

    let confirmModalCallback = null;

    let topZIndex = 20;
    const openWindows = new Set();

    const LARGE_NUM_SUFFIXES = [
        { exp: 3, sym: 'K' },
        { exp: 6, sym: 'M' },
        { exp: 9, sym: 'B' },
        { exp: 12, sym: 'T' },
        { exp: 15, sym: 'Qa' },
        { exp: 18, sym: 'Qi' },
        { exp: 21, sym: 'Sx' },
        { exp: 24, sym: 'Sp' },
        { exp: 27, sym: 'Oc' },
        { exp: 30, sym: 'No' },
        { exp: 33, sym: 'Dc' },
        { exp: 36, sym: 'Ud' },
        { exp: 39, sym: 'Dd' },
        { exp: 42, sym: 'Td' },
        { exp: 45, sym: 'Qad' },
        { exp: 48, sym: 'Qid' },
        { exp: 51, sym: 'Sxd' },
        { exp: 54, sym: 'Spd' },
        { exp: 57, sym: 'Ocd' },
        { exp: 60, sym: 'Nod' },
        { exp: 63, sym: 'Vg' },
        { exp: 66, sym: 'Uvg' },
        { exp: 69, sym: 'Dvg' },
        { exp: 72, sym: 'Tvg' },
        { exp: 75, sym: 'Qavg' },
        { exp: 78, sym: 'Qivg' },
        { exp: 81, sym: 'Sxvg' },
        { exp: 84, sym: 'Spvg' },
        { exp: 87, sym: 'Ocvg' },
        { exp: 90, sym: 'Novg' },
        { exp: 93, sym: 'Tg' },
        { exp: 96, sym: 'Utg' },
        { exp: 99, sym: 'Dtg' },
        { exp: 100, sym: 'Googol' }
    ];

    function formatWithLargeSuffix(val) {
        if (val === undefined || val === null) return '0';
        let str = String(val).trim();
        if (!str || str === '0') return '0';

        let isNegative = false;
        if (str.startsWith('-')) {
            isNegative = true;
            str = str.slice(1);
        }

        let integerDigits = str;
        let hasDecimal = str.includes('.');
        if (hasDecimal) {
            const parts = str.split('.');
            integerDigits = parts[0] || '0';
        }

        if (!/^\d+$/.test(integerDigits)) {
            return (isNegative ? '-' : '') + str;
        }

        try {
            const bigVal = BigInt(integerDigits);
            if (bigVal < 1000n) {
                if (hasDecimal) {
                    return (isNegative ? '-' : '') + Number(str).toLocaleString('en-US', { maximumFractionDigits: 2 });
                }
                return (isNegative ? '-' : '') + bigVal.toLocaleString('en-US');
            }

            let chosen = null;
            for (let i = LARGE_NUM_SUFFIXES.length - 1; i >= 0; i--) {
                const s = LARGE_NUM_SUFFIXES[i];
                const divisor = 10n ** BigInt(s.exp);
                if (bigVal >= divisor) {
                    chosen = s;
                    break;
                }
            }

            if (!chosen) {
                return (isNegative ? '-' : '') + bigVal.toLocaleString('en-US');
            }

            const divisor = 10n ** BigInt(chosen.exp);
            const wholePart = bigVal / divisor;
            const remainder = bigVal % divisor;

            const scaled = (remainder * 1000n) / divisor;
            let roundedDec = (scaled + 5n) / 10n;
            let finalWhole = wholePart;
            if (roundedDec >= 100n) {
                finalWhole += 1n;
                roundedDec = 0n;
            }

            const decStr = String(roundedDec).padStart(2, '0');
            return `${isNegative ? '-' : ''}${finalWhole}.${decStr} ${chosen.sym}`;
        } catch (e) {
            return (isNegative ? '-' : '') + str;
        }
    }

    function fmtCurrency(val) {
        return formatWithLargeSuffix(val);
    }

    function fmtNum(val) {
        if (val === undefined || val === null) return '0';
        try {
            const s = String(val);
            if (s.includes('.')) {
                return Number(s).toLocaleString('en-US', { maximumFractionDigits: 2 });
            }
            return BigInt(s).toLocaleString('en-US');
        } catch (e) {
            return Number(val || 0).toLocaleString('en-US');
        }
    }

    function fmtDurationSec(totalSec) {
        const s = Math.max(0, Math.floor(totalSec));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}h ${m}m ${sec}s`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    }

    function highlightKeywords(text) {
        if (!text) return '';
        let safe = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        safe = safe.replace(/Basic Luck/gi, '<span class="kw-basic">$&</span>');
        safe = safe.replace(/Multi Luck/gi, '<span class="kw-multi">$&</span>');
        safe = safe.replace(/Special Luck/gi, '<span class="kw-special">$&</span>');
        safe = safe.replace(/FINAL LUCK/gi, '<span class="kw-final">$&</span>');
        return safe;
    }

    function applyCustomWallpaper(dataUrl, fitMode) {
        const desktopEl = document.getElementById('desktop');
        const previewBox = document.getElementById('wallpaper-preview-box');
        const resetBtn = document.getElementById('btn-wallpaper-reset');
        const fitSelect = document.getElementById('set-wallpaper-fit');

        const allowedFits = new Set(['cover', 'contain', '100% 100%']);
        const savedFit = fitMode || localStorage.getItem('aris_custom_wallpaper_fit') || 'cover';
        const resolvedFit = allowedFits.has(savedFit) ? savedFit : 'cover';
        if (fitSelect) fitSelect.value = resolvedFit;

        const cleanUrl = (typeof dataUrl === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl))
            ? dataUrl.replace(/"/g, '%22')
            : '';

        if (desktopEl) {
            if (cleanUrl) {
                desktopEl.classList.add('has-custom-wallpaper');
                desktopEl.style.backgroundImage = `url("${cleanUrl}")`;
                desktopEl.style.backgroundSize = resolvedFit;
                desktopEl.style.backgroundPosition = 'center center';
                desktopEl.style.backgroundRepeat = 'no-repeat';
            } else {
                desktopEl.classList.remove('has-custom-wallpaper');
                desktopEl.style.backgroundImage = '';
                desktopEl.style.backgroundSize = '';
                desktopEl.style.backgroundPosition = '';
                desktopEl.style.backgroundRepeat = '';
            }
        }

        if (previewBox) {
            previewBox.style.backgroundImage = cleanUrl ? `url("${cleanUrl}")` : '';
        }
        if (resetBtn) {
            resetBtn.classList.toggle('hidden', !cleanUrl);
        }
    }

    function compressWallpaperIfNeeded(dataUrl, file) {
        return new Promise((resolve) => {
            const isGif = file.type === 'image/gif';
            if (isGif || dataUrl.length <= 1800000) {
                resolve(dataUrl);
                return;
            }
            const img = new Image();
            img.onload = () => {
                try {
                    const maxW = 1920;
                    const maxH = 1080;
                    let targetW = img.naturalWidth || maxW;
                    let targetH = img.naturalHeight || maxH;
                    const ratio = Math.min(1, maxW / targetW, maxH / targetH);
                    targetW = Math.max(1, Math.round(targetW * ratio));
                    targetH = Math.max(1, Math.round(targetH * ratio));
                    const canvas = document.createElement('canvas');
                    canvas.width = targetW;
                    canvas.height = targetH;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) { resolve(dataUrl); return; }
                    ctx.drawImage(img, 0, 0, targetW, targetH);
                    const compressed = canvas.toDataURL('image/jpeg', 0.88);
                    resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
                } catch {
                    resolve(dataUrl);
                }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    function applyOsVisualPreferences(settings) {
        const theme = settings?.theme || localStorage.getItem('aris_theme') || 'dark';
        if (theme === 'light') {
            document.body.classList.add('light-theme');
        } else {
            document.body.classList.remove('light-theme');
        }
        localStorage.setItem('aris_theme', theme);

        const hideWm = settings?.hide_watermark !== undefined
            ? Boolean(settings.hide_watermark)
            : localStorage.getItem('aris_hide_watermark') === '1';
        const wmEl = document.getElementById('desktop-watermark');
        if (wmEl) {
            wmEl.classList.toggle('hidden', hideWm);
        }
        localStorage.setItem('aris_hide_watermark', hideWm ? '1' : '0');

        if (settings?.disable_welcome !== undefined) {
            localStorage.setItem('aris_disable_welcome', settings.disable_welcome ? '1' : '0');
        }

        const customWallpaper = localStorage.getItem('aris_custom_wallpaper') || '';
        const wallpaperFit = localStorage.getItem('aris_custom_wallpaper_fit') || 'cover';
        applyCustomWallpaper(customWallpaper, wallpaperFit);
    }

    function showWinToast(message, type = 'info', title = 'A.R.I.S System') {
        const container = document.getElementById('win-toast-container');
        if (!container) return;

        const cleanMsg = (message || '').replace(/\*\*/g, '');
        const toast = document.createElement('div');
        toast.className = `win-toast toast-${type}`;
        toast.innerHTML = `
            <div class="win-toast-header">
                <span>${title}</span>
                <button class="win-toast-close" title="Dismiss">✕</button>
            </div>
            <div class="win-toast-body">${cleanMsg}</div>
        `;

        const closeBtn = toast.querySelector('.win-toast-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(60px)';
                setTimeout(() => toast.remove(), 200);
            });
        }

        container.appendChild(toast);

        while (container.children.length > 4) {
            container.removeChild(container.firstChild);
        }

        setTimeout(() => {
            if (toast.parentElement) {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(60px)';
                setTimeout(() => toast.remove(), 200);
            }
        }, 3600);
    }

    async function apiGet(url) {
        let data;
        try {
            const res = await fetch(url, {
                headers: {
                    ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {})
                }
            });
            data = await res.json();
        } catch (err) {
            return { ok: false, error: 'NETWORK_ERROR', message: '❌ Network or server error. Please try again.' };
        }
        return data || { ok: false, message: '❌ Empty server response.' };
    }

    async function apiPost(url, body) {
        let data;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {})
                },
                body: JSON.stringify(body || {})
            });
            data = await res.json();
        } catch (err) {
            return { ok: false, error: 'NETWORK_ERROR', message: '❌ Network or server error. Please try again.' };
        }
        return data || { ok: false, message: '❌ Empty server response.' };
    }

    function closeConfirmModal(flash = false) {
        confirmModalCallback = null;
        const modalEl = document.getElementById('win-confirm-modal');
        if (modalEl && !modalEl.classList.contains('hidden')) {
            if (flash) {
                modalEl.classList.remove('win-modal-flash');
                void modalEl.offsetWidth;
                modalEl.classList.add('win-modal-flash');
                setTimeout(() => {
                    if (modalEl) {
                        modalEl.classList.remove('win-modal-flash');
                        modalEl.classList.add('hidden');
                        modalEl.classList.remove('active-window');
                    }
                }, 350);
            } else {
                modalEl.classList.add('hidden');
                modalEl.classList.remove('active-window');
            }
        }
    }

    function openConfirmModal(title, htmlDesc, onConfirm) {
        const modalEl = document.getElementById('win-confirm-modal');
        if (!modalEl) {
            if (onConfirm) onConfirm();
            return;
        }
        confirmModalCallback = onConfirm;
        const titleEl = document.getElementById('confirm-modal-title');
        const descEl = document.getElementById('confirm-modal-desc');
        if (titleEl) titleEl.textContent = title || '⚠️ Confirm Action';
        if (descEl) descEl.innerHTML = htmlDesc || 'Are you sure you want to proceed?';
        modalEl.classList.remove('hidden');
        topZIndex += 5;
        modalEl.style.zIndex = topZIndex;
    }

    function focusWindow(winEl) {
        if (!winEl) return;
        if (winEl.id !== 'win-confirm-modal') {
            closeConfirmModal(true);
        }
        document.querySelectorAll('.window').forEach(w => w.classList.remove('active-window'));
        winEl.classList.add('active-window');
        topZIndex += 1;
        winEl.style.zIndex = topZIndex;
        renderTaskbar();
    }

    function animateWindowBoundsChange(winEl, fromRect, toRect, isClosingOrMinimizing = false) {
        if (!winEl || !fromRect || !toRect || !winEl.animate) return;
        const easing = isClosingOrMinimizing ? 'cubic-bezier(0.32, 0, 0.67, 0)' : 'cubic-bezier(0.16, 1, 0.3, 1)';
        try {
            if (isClosingOrMinimizing) {
                const targetDx = toRect.left - fromRect.left;
                const targetDy = toRect.top - fromRect.top;
                const targetScaleX = Math.max(0.01, toRect.width / Math.max(1, fromRect.width));
                const targetScaleY = Math.max(0.01, toRect.height / Math.max(1, fromRect.height));
                const anim = winEl.animate([
                    { transformOrigin: 'top left', transform: 'none', opacity: 1 },
                    { transformOrigin: 'top left', transform: `translate(${targetDx}px, ${targetDy}px) scale(${targetScaleX}, ${targetScaleY})`, opacity: 0 }
                ], {
                    duration: 180,
                    easing: easing,
                    fill: 'forwards'
                });
                const finish = () => {
                    winEl.classList.add('hidden');
                    winEl.classList.remove('active-window');
                    try { anim.cancel(); } catch (e) {}
                    renderTaskbar();
                };
                anim.onfinish = finish;
                winEl.__minAnim = anim;
            } else {
                const startDx = fromRect.left - toRect.left;
                const startDy = fromRect.top - toRect.top;
                const startScaleX = Math.max(0.01, fromRect.width / Math.max(1, toRect.width));
                const startScaleY = Math.max(0.01, fromRect.height / Math.max(1, toRect.height));
                winEl.animate([
                    { transformOrigin: 'top left', transform: `translate(${startDx}px, ${startDy}px) scale(${startScaleX}, ${startScaleY})`, opacity: 0 },
                    { transformOrigin: 'top left', transform: 'none', opacity: 1 }
                ], {
                    duration: 200,
                    easing: easing,
                    fill: 'none'
                });
            }
        } catch (e) {}
    }

    function updateWindowControls(winEl, isMaxOrSnapped) {
        if (!winEl) return;
        const btnMax = winEl.querySelector('.btn-max');
        if (btnMax) {
            btnMax.innerHTML = isMaxOrSnapped ? '&#x274F;' : '&#x25A1;';
            btnMax.title = isMaxOrSnapped ? 'Restore Down' : 'Maximize';
        }
    }

    function openWindow(winId, tabToActivate = null) {
        if ((winId === 'win-users' || winId === 'win-dev-control') && isDevAccount) {
            winId = 'win-dev-control';
        }
        const winEl = document.getElementById(winId);
        if (!winEl) return;

        if (openWindows.has(winId) && !winEl.classList.contains('hidden')) {
            focusWindow(winEl);
            if (tabToActivate) {
                activateWindowTab(winId, tabToActivate);
            }
            return;
        }

        const isRestoring = openWindows.has(winId) && winEl.classList.contains('hidden');
        winEl.classList.remove('hidden');
        winEl.classList.remove('anim-closing', 'anim-minimizing');

        if (isRestoring) {
            const taskbarBtn = document.querySelector(`.taskbar-item[data-win-id="${winId}"]`);
            if (taskbarBtn && winEl.animate) {
                animateWindowBoundsChange(winEl, taskbarBtn.getBoundingClientRect(), winEl.getBoundingClientRect(), false);
            } else {
                winEl.classList.add('anim-restoring');
                setTimeout(() => winEl.classList.remove('anim-restoring'), 200);
            }
        } else if (!openWindows.has(winId)) {
            winEl.classList.add('anim-opening');
            setTimeout(() => winEl.classList.remove('anim-opening'), 200);
        }

        if (winId !== 'win-confirm-modal') {
            openWindows.add(winId);
        }
        focusWindow(winEl);

        if (winId === 'win-leaderboard') {
            loadLeaderboard();
        } else if (winId === 'win-dev-control' && isDevAccount) {
            refreshDevControlOverview();
        } else if (winId === 'win-taskmgr') {
            updateTaskMgrGraph();
            renderHardwareCounters();
        }

        if (tabToActivate) {
            activateWindowTab(winId, tabToActivate);
        }
        window.dispatchEvent(new CustomEvent('aris:window-open', { detail: { winId, tab: tabToActivate || null } }));
    }

    let lastTabSwitchTime = 0;
    function activateWindowTab(winId, tabName) {
        const now = Date.now();
        if (now - lastTabSwitchTime < 200) return;
        lastTabSwitchTime = now;
        if (winId === 'win-shop') {
            const btn = document.querySelector(`[data-shop-tab="${tabName}"]`);
            if (btn) btn.click();
        } else if (winId === 'win-inventory') {
            const btn = document.querySelector(`[data-inv-tab="${tabName}"]`);
            if (btn) btn.click();
        } else if (winId === 'win-profile') {
            const btn = document.querySelector(`[data-prof-tab="${tabName}"]`);
            if (btn) btn.click();
        } else if (winId === 'win-hub') {
            const btn = document.querySelector(`[data-hub-tab="${tabName}"]`);
            if (btn) btn.click();
        } else if (winId === 'win-dev-control') {
            const btn = document.querySelector(`[data-dev-tab="${tabName}"]`);
            if (btn) btn.click();
        } else if (winId === 'win-taskmgr') {
            const btn = document.querySelector(`[data-taskmgr-tab="${tabName}"]`);
            if (btn) btn.click();
        }
    }

    function minimizeWindow(winId) {
        const winEl = document.getElementById(winId);
        if (!winEl) return;
        window.dispatchEvent(new CustomEvent('aris:window-minimize', { detail: { winId } }));

        const taskbarBtn = document.querySelector(`.taskbar-item[data-win-id="${winId}"]`);
        if (taskbarBtn && winEl.animate) {
            animateWindowBoundsChange(winEl, winEl.getBoundingClientRect(), taskbarBtn.getBoundingClientRect(), true);
            return;
        }

        winEl.classList.add('anim-minimizing');
        setTimeout(() => {
            winEl.classList.remove('anim-minimizing');
            winEl.classList.add('hidden');
            winEl.classList.remove('active-window');
            renderTaskbar();
        }, 175);
    }

    function closeWindow(winId) {
        hideTaskbarPreview();
        const winEl = document.getElementById(winId);
        if (!winEl) return;
        window.dispatchEvent(new CustomEvent('aris:window-close', { detail: { winId } }));

        winEl.classList.add('anim-closing');
        setTimeout(() => {
            winEl.classList.remove('anim-closing');
            winEl.classList.add('hidden');
            winEl.classList.remove('active-window');
            openWindows.delete(winId);
            renderTaskbar();
        }, 140);
    }

    function toggleMaximizeWindow(winId) {
        const winEl = document.getElementById(winId);
        if (!winEl) return;

        const isMax = winEl.classList.contains('maximized');
        const isSnapped = ['snapped-left', 'snapped-right', 'snapped-top-left', 'snapped-top-right', 'snapped-bottom-left', 'snapped-bottom-right'].some(c => winEl.classList.contains(c));

        if (isMax || isSnapped) {
            const fromRect = winEl.getBoundingClientRect();
            winEl.classList.remove(
                'maximized',
                'snapped-left',
                'snapped-right',
                'snapped-top-left',
                'snapped-top-right',
                'snapped-bottom-left',
                'snapped-bottom-right'
            );

            winEl.classList.add('anim-size-transition');
            setTimeout(() => winEl.classList.remove('anim-size-transition'), 220);

            const restoreW = parseInt(winEl.dataset.origW) || 720;
            const restoreH = parseInt(winEl.dataset.origH) || 480;
            const restoreL = parseInt(winEl.dataset.origL) ?? Math.max(20, Math.floor((window.innerWidth - restoreW) / 2));
            const restoreT = parseInt(winEl.dataset.origT) ?? Math.max(30, Math.floor((window.innerHeight - 40 - restoreH) / 2));

            winEl.style.width = `${restoreW}px`;
            winEl.style.height = `${restoreH}px`;
            winEl.style.left = `${restoreL}px`;
            winEl.style.top = `${restoreT}px`;

            const toRect = winEl.getBoundingClientRect();
            if (winEl.animate && fromRect && toRect) {
                const dx = fromRect.left - toRect.left;
                const dy = fromRect.top - toRect.top;
                const dw = Math.max(0.01, fromRect.width / Math.max(1, toRect.width));
                const dh = Math.max(0.01, fromRect.height / Math.max(1, toRect.height));
                winEl.animate([
                    { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${dw}, ${dh})` },
                    { transformOrigin: 'top left', transform: 'none' }
                ], {
                    duration: 200,
                    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
                    fill: 'none'
                });
            }
            updateWindowControls(winEl, false);
            focusWindow(winEl);
        } else {
            applyWindowSnap(winEl, 'maximized');
        }
    }

    function closeAllWindows() {
        closeConfirmModal();
        document.querySelectorAll('.window').forEach(w => {
            w.classList.add('hidden');
            w.classList.remove('active-window');
        });
        openWindows.clear();
        renderTaskbar();
    }

    function toggleStartMenu(force) {
        const sm = document.getElementById('start-menu');
        if (!sm) return;
        if (force === undefined) {
            sm.classList.toggle('hidden');
        } else if (force) {
            sm.classList.remove('hidden');
        } else {
            sm.classList.add('hidden');
        }
    }

    function hideTaskbarPreview() {
        const previewCard = document.getElementById('taskbar-preview-card');
        if (previewCard) previewCard.classList.add('hidden');
    }

    function showTaskbarPreview(btn, winId) {
        const previewCard = document.getElementById('taskbar-preview-card');
        if (!previewCard) return;
        const winEl = document.getElementById(winId);
        if (!winEl) return;
        const title = winEl.getAttribute('data-title') || winId;
        const icon = winEl.getAttribute('data-icon') || '🗔';
        const isHidden = winEl.classList.contains('hidden');

        previewCard.innerHTML = `
            <div class="preview-card-header">
                <div class="preview-card-title-wrap">
                    <span class="preview-card-icon">${icon}</span>
                    <span class="preview-card-title">${escapeHtml(title)}</span>
                </div>
                <button class="preview-card-close-btn" title="Close Window">&#x2715;</button>
            </div>
            <div class="preview-card-thumb"></div>
        `;

        const thumbWrap = previewCard.querySelector('.preview-card-thumb');
        if (thumbWrap) {
            const winW = Math.max(winEl.offsetWidth || parseInt(winEl.style.width, 10) || 640, 320);
            const winH = Math.max(winEl.offsetHeight || parseInt(winEl.style.height, 10) || 440, 220);
            const boxW = 230;
            const boxH = 144;
            const scale = Math.min(boxW / winW, boxH / winH);
            const scaledW = Math.max(1, Math.round(winW * scale));
            const scaledH = Math.max(1, Math.round(winH * scale));

            const stage = document.createElement('div');
            stage.className = 'preview-card-thumb-stage';
            stage.style.width = `${scaledW}px`;
            stage.style.height = `${scaledH}px`;

            const clone = winEl.cloneNode(true);
            clone.removeAttribute('id');
            clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
            clone.querySelectorAll('.win-resizer, .win-resize-edge, .win-snap-flyout, .resize-min-badge').forEach(el => el.remove());

            const origCanvases = winEl.querySelectorAll('canvas');
            const cloneCanvases = clone.querySelectorAll('canvas');
            origCanvases.forEach((origCanvas, idx) => {
                const cloneCanvas = cloneCanvases[idx];
                if (!cloneCanvas || origCanvas.width <= 0 || origCanvas.height <= 0) return;
                cloneCanvas.width = origCanvas.width;
                cloneCanvas.height = origCanvas.height;
                try {
                    const ctx = cloneCanvas.getContext('2d');
                    if (ctx) ctx.drawImage(origCanvas, 0, 0);
                } catch {}
            });

            clone.querySelectorAll('iframe').forEach(ifr => {
                const stub = document.createElement('div');
                stub.className = 'preview-card-iframe-stub';
                stub.textContent = '▶ Media Player View';
                ifr.replaceWith(stub);
            });

            clone.classList.remove('hidden', 'minimized', 'anim-open', 'anim-min', 'anim-close');
            clone.style.position = 'absolute';
            clone.style.left = '0';
            clone.style.top = '0';
            clone.style.right = 'auto';
            clone.style.bottom = 'auto';
            clone.style.margin = '0';
            clone.style.width = `${winW}px`;
            clone.style.height = `${winH}px`;
            clone.style.transform = `scale(${scale})`;
            clone.style.transformOrigin = 'top left';
            clone.style.pointerEvents = 'none';
            clone.style.display = 'flex';
            clone.style.zIndex = '1';

            stage.appendChild(clone);
            thumbWrap.appendChild(stage);
        }

        const closeBtn = previewCard.querySelector('.preview-card-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeWindow(winId);
                hideTaskbarPreview();
            });
        }

        previewCard.onmousedown = (e) => {
            if (e.target.closest('.preview-card-close-btn')) return;
            e.stopPropagation();
            if (isHidden) {
                openWindow(winId);
            } else {
                focusWindow(winEl);
            }
            hideTaskbarPreview();
        };

        if (!previewCard.dataset.hoverBound) {
            previewCard.dataset.hoverBound = '1';
            previewCard.addEventListener('mouseenter', () => {
                clearTimeout(previewHideTimeout);
            });
            previewCard.addEventListener('mouseleave', () => {
                previewHideTimeout = setTimeout(() => hideTaskbarPreview(), 200);
            });
        }

        previewCard.classList.remove('hidden');

        const btnRect = btn.getBoundingClientRect();
        const cardWidth = 248;
        let leftPos = btnRect.left + (btnRect.width / 2) - (cardWidth / 2);
        if (leftPos < 8) leftPos = 8;
        if (leftPos + cardWidth > window.innerWidth - 8) leftPos = window.innerWidth - cardWidth - 8;
        previewCard.style.left = `${leftPos}px`;
        previewCard.style.bottom = '46px';
    }

    function applyWindowSnap(winEl, snapType) {
        if (!winEl) return;
        if (!winEl.classList.contains('maximized') &&
            !winEl.classList.contains('snapped-left') &&
            !winEl.classList.contains('snapped-right') &&
            !winEl.classList.contains('snapped-top-left') &&
            !winEl.classList.contains('snapped-top-right') &&
            !winEl.classList.contains('snapped-bottom-left') &&
            !winEl.classList.contains('snapped-bottom-right')) {
            winEl.dataset.origW = `${winEl.offsetWidth}px`;
            winEl.dataset.origH = `${winEl.offsetHeight}px`;
            winEl.dataset.origL = `${winEl.offsetLeft}px`;
            winEl.dataset.origT = `${winEl.offsetTop}px`;
        }

        const fromRect = winEl.getBoundingClientRect();

        winEl.classList.remove(
            'maximized',
            'snapped-left',
            'snapped-right',
            'snapped-top-left',
            'snapped-top-right',
            'snapped-bottom-left',
            'snapped-bottom-right'
        );

        winEl.classList.add('anim-size-transition');
        setTimeout(() => winEl.classList.remove('anim-size-transition'), 220);

        if (snapType === 'maximized' || snapType === 'top') {
            winEl.classList.add('maximized');
        } else if (snapType === 'left') {
            winEl.classList.add('snapped-left');
        } else if (snapType === 'right') {
            winEl.classList.add('snapped-right');
        } else if (snapType === 'top-left') {
            winEl.classList.add('snapped-top-left');
        } else if (snapType === 'top-right') {
            winEl.classList.add('snapped-top-right');
        } else if (snapType === 'bottom-left') {
            winEl.classList.add('snapped-bottom-left');
        } else if (snapType === 'bottom-right') {
            winEl.classList.add('snapped-bottom-right');
        }

        const toRect = winEl.getBoundingClientRect();
        if (winEl.animate && fromRect && toRect && (fromRect.width !== toRect.width || fromRect.left !== toRect.left || fromRect.top !== toRect.top)) {
            const dx = fromRect.left - toRect.left;
            const dy = fromRect.top - toRect.top;
            const dw = Math.max(0.01, fromRect.width / Math.max(1, toRect.width));
            const dh = Math.max(0.01, fromRect.height / Math.max(1, toRect.height));
            winEl.animate([
                { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${dw}, ${dh})` },
                { transformOrigin: 'top left', transform: 'none' }
            ], {
                duration: 200,
                easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
                fill: 'none'
            });
        }

        updateWindowControls(winEl, true);
        focusWindow(winEl);
    }

    function renderTaskbar() {
        const container = document.getElementById('taskbar-apps');
        if (!container) return;
        container.innerHTML = '';

        const isCrowded = openWindows.size >= 5 || (container.parentElement && container.clientWidth < openWindows.size * 125);
        container.classList.toggle('taskbar-compact', isCrowded);

        openWindows.forEach(winId => {
            if (winId === 'win-confirm-modal') return;
            const winEl = document.getElementById(winId);
            if (!winEl) return;
            const title = winEl.getAttribute('data-title') || winId;
            const icon = winEl.getAttribute('data-icon') || '🗔';
            const isHidden = winEl.classList.contains('hidden');
            const isFocused = winEl.classList.contains('active-window') && !isHidden;

            const btn = document.createElement('button');
            let itemClass = 'taskbar-item';
            if (isFocused) {
                itemClass += ' focused';
            } else if (isHidden) {
                itemClass += ' minimized';
            }
            btn.className = itemClass;
            btn.setAttribute('data-win-id', winId);
            btn.title = title;
            btn.innerHTML = `<span class="task-icon">${icon}</span><span class="task-title">${title}</span>`;
            btn.setAttribute('data-win-id', winId);
            btn.title = title;
            btn.innerHTML = `<span class="task-icon">${icon}</span><span class="task-title">${title}</span>`;
            
            btn.addEventListener('click', () => {
                closeConfirmModal();
                if (isFocused) {
                    minimizeWindow(winId);
                } else {
                    openWindow(winId);
                }
            });

            btn.addEventListener('auxclick', (e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeWindow(winId);
                    hideTaskbarPreview();
                }
            });
            btn.addEventListener('mousedown', (e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeWindow(winId);
                    hideTaskbarPreview();
                }
            });

            btn.addEventListener('mouseenter', () => {
                clearTimeout(previewHideTimeout);
                showTaskbarPreview(btn, winId);
            });
            btn.addEventListener('mouseleave', () => {
                previewHideTimeout = setTimeout(() => hideTaskbarPreview(), 200);
            });

            container.appendChild(btn);
        });
    }

    function bindSingleWindowLifecycle(winEl) {
        if (!winEl || winEl.dataset.bound === '1') return;
        winEl.dataset.bound = '1';
        const winId = winEl.id;

        if (winEl.classList.contains('hidden')) {
            openWindows.delete(winId);
        }

        winEl.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            focusWindow(winEl);
        });

        winEl.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const btnMin = winEl.querySelector('.btn-min');
        const btnMax = winEl.querySelector('.btn-max');
        const btnClose = winEl.querySelector('.btn-close');

        if (btnMin) btnMin.addEventListener('click', (e) => { e.stopPropagation(); minimizeWindow(winId); });
        if (btnMax) btnMax.addEventListener('click', (e) => { e.stopPropagation(); toggleMaximizeWindow(winId); });
        if (btnClose) btnClose.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(winId); });

        if (winId !== 'win-confirm-modal' && btnMax && !winEl.querySelector('.win-snap-flyout')) {
            const flyout = document.createElement('div');
            flyout.className = 'win-snap-flyout hidden';
            flyout.innerHTML = `
                <div class="snap-layout-title">Snap Layouts</div>
                <div class="snap-layouts-container">
                    <div class="snap-layout-card" title="Split Screen (50/50)">
                        <div class="snap-zone snap-zone-col" data-snap="left" title="Left Half"></div>
                        <div class="snap-zone snap-zone-col" data-snap="right" title="Right Half"></div>
                    </div>
                    <div class="snap-layout-card grid-2x2" title="Quadrant Grid (4 Corners)">
                        <div class="snap-zone" data-snap="top-left" title="Top-Left"></div>
                        <div class="snap-zone" data-snap="top-right" title="Top-Right"></div>
                        <div class="snap-zone" data-snap="bottom-left" title="Bottom-Left"></div>
                        <div class="snap-zone" data-snap="bottom-right" title="Bottom-Right"></div>
                    </div>
                </div>
            `;
            const headerEl = winEl.querySelector('.title-bar') || winEl;
            headerEl.appendChild(flyout);

            let snapHoverTimer = null;
            let flyoutLeaveTimer = null;

            btnMax.addEventListener('mouseenter', () => {
                clearTimeout(flyoutLeaveTimer);
                snapHoverTimer = setTimeout(() => {
                    flyout.classList.remove('hidden');
                }, 250);
            });

            btnMax.addEventListener('mouseleave', () => {
                clearTimeout(snapHoverTimer);
                flyoutLeaveTimer = setTimeout(() => {
                    flyout.classList.add('hidden');
                }, 150);
            });

            flyout.addEventListener('mouseenter', () => {
                clearTimeout(flyoutLeaveTimer);
            });

            flyout.addEventListener('mouseleave', () => {
                flyoutLeaveTimer = setTimeout(() => {
                    flyout.classList.add('hidden');
                }, 150);
            });

            flyout.querySelectorAll('.snap-zone').forEach(zone => {
                zone.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const snapType = zone.getAttribute('data-snap');
                    applyWindowSnap(winEl, snapType);
                    flyout.classList.add('hidden');
                });
            });
        }

        if (winId !== 'win-confirm-modal' && !winEl.querySelector('.win-resizer')) {
            const resizeDirs = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
            let activeResizeDir = null;
            let rStartX = 0, rStartY = 0, startW = 0, startH = 0, startL = 0, startT = 0;
            let resizeWarnTimer = null;

            const stopWindowResize = () => {
                if (!activeResizeDir) return;
                activeResizeDir = null;
                document.body.classList.remove('is-window-resizing');
            };

            resizeDirs.forEach(dir => {
                const handle = document.createElement('div');
                handle.className = dir === 'se' ? 'win-resizer' : `win-resize-edge win-resize-${dir}`;
                if (dir === 'se') handle.title = 'Drag to resize window';
                winEl.appendChild(handle);

                handle.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    if (winEl.classList.contains('maximized') ||
                        winEl.classList.contains('snapped-left') ||
                        winEl.classList.contains('snapped-right') ||
                        winEl.classList.contains('snapped-top-left') ||
                        winEl.classList.contains('snapped-top-right') ||
                        winEl.classList.contains('snapped-bottom-left') ||
                        winEl.classList.contains('snapped-bottom-right') ||
                        winEl.classList.contains('ad-fullscreen-locked')) return;
                    e.stopPropagation();
                    e.preventDefault();

                    const rect = winEl.getBoundingClientRect();
                    startL = winEl.offsetLeft || rect.left;
                    startT = winEl.offsetTop || rect.top;
                    startW = winEl.offsetWidth || rect.width;
                    startH = winEl.offsetHeight || rect.height;
                    winEl.style.left = `${startL}px`;
                    winEl.style.top = `${startT}px`;
                    winEl.style.right = 'auto';
                    winEl.style.bottom = 'auto';
                    winEl.style.transform = 'none';

                    activeResizeDir = dir;
                    rStartX = e.clientX;
                    rStartY = e.clientY;
                    document.body.classList.add('is-window-resizing');
                    focusWindow(winEl);
                });
            });

            window.addEventListener('mousemove', (e) => {
                if (!activeResizeDir) return;
                const minW = Math.max(380, parseInt(window.getComputedStyle(winEl).minWidth, 10) || 380);
                const minH = Math.max(260, parseInt(window.getComputedStyle(winEl).minHeight, 10) || 260);
                const dx = e.clientX - rStartX;
                const dy = e.clientY - rStartY;
                const maxViewportW = Math.max(400, window.innerWidth - 8);
                const maxViewportH = Math.max(300, window.innerHeight - 52);

                let newL = startL;
                let newT = startT;
                let newW = startW;
                let newH = startH;
                let hitMinBound = false;

                if (activeResizeDir.includes('e')) {
                    const targetW = startW + dx;
                    if (targetW < minW) hitMinBound = true;
                    newW = Math.max(minW, Math.min(maxViewportW - startL, targetW));
                }
                if (activeResizeDir.includes('w')) {
                    const targetW = startW - dx;
                    if (targetW < minW) hitMinBound = true;
                    const maxLeft = startL + startW - minW;
                    newL = Math.max(8, Math.min(maxLeft, startL + dx));
                    newW = startW + (startL - newL);
                }
                if (activeResizeDir.includes('s')) {
                    const targetH = startH + dy;
                    if (targetH < minH) hitMinBound = true;
                    newH = Math.max(minH, Math.min(maxViewportH - startT, targetH));
                }
                if (activeResizeDir.includes('n')) {
                    const targetH = startH - dy;
                    if (targetH < minH) hitMinBound = true;
                    const maxTop = startT + startH - minH;
                    newT = Math.max(8, Math.min(maxTop, startT + dy));
                    newH = startH + (startT - newT);
                }

                if (hitMinBound) {
                    let badge = winEl.querySelector('.resize-min-badge');
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.className = 'resize-min-badge';
                        badge.textContent = `⚠️ Minimum size: ${minW}×${minH}px`;
                        winEl.appendChild(badge);
                    }
                    if (resizeWarnTimer) clearTimeout(resizeWarnTimer);
                    resizeWarnTimer = setTimeout(() => {
                        const b = winEl.querySelector('.resize-min-badge');
                        if (b) b.remove();
                    }, 2200);
                }

                winEl.style.left = `${newL}px`;
                winEl.style.top = `${newT}px`;
                winEl.style.width = `${newW}px`;
                winEl.style.height = `${newH}px`;
                if (winId === 'win-taskmgr' && typeof updateTaskMgrGraph === 'function') {
                    updateTaskMgrGraph();
                }
            });

            window.addEventListener('mouseup', stopWindowResize);
            window.addEventListener('blur', stopWindowResize);
        }

        const titleBar = winEl.querySelector('.title-bar');
        if (!titleBar) return;

        let isDragging = false;
        let startX = 0, startY = 0, origLeft = 0, origTop = 0;
        let snapCandidate = null;
        let pendingRestore = false;
        let restoreAnchorRatio = 0.5;
        let ghostOverlay = document.getElementById('snap-ghost-overlay');
        const isWinMaxOrSnapped = (el) => ['maximized', 'snapped-left', 'snapped-right', 'snapped-top-left', 'snapped-top-right', 'snapped-bottom-left', 'snapped-bottom-right'].some(c => el.classList.contains(c));

        titleBar.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.title-bar-controls') || e.target.closest('.win-snap-flyout')) return;
            if (winEl.classList.contains('ad-fullscreen-locked')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            focusWindow(winEl);

            if (isWinMaxOrSnapped(winEl)) {
                pendingRestore = true;
                restoreAnchorRatio = Math.min(1, Math.max(0, (e.clientX - winEl.getBoundingClientRect().left) / Math.max(1, winEl.offsetWidth)));
            } else {
                pendingRestore = false;
                origLeft = winEl.offsetLeft;
                origTop = winEl.offsetTop;
            }
        });

        titleBar.addEventListener('dblclick', (e) => {
            if (e.target.closest('.title-bar-controls') || e.target.closest('.win-snap-flyout')) return;
            if (winId === 'win-confirm-modal') return;
            toggleMaximizeWindow(winId);
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            if (pendingRestore) {
                if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return;
                pendingRestore = false;
                const restoreW = parseInt(winEl.dataset.origW) || 720;
                const restoreH = parseInt(winEl.dataset.origH) || 480;
                winEl.classList.remove('maximized', 'snapped-left', 'snapped-right', 'snapped-top-left', 'snapped-top-right', 'snapped-bottom-left', 'snapped-bottom-right');
                winEl.style.width = `${restoreW}px`;
                winEl.style.height = `${restoreH}px`;
                origLeft = e.clientX - Math.floor(restoreW * restoreAnchorRatio);
                origTop = Math.max(0, e.clientY - 16);
                winEl.style.left = `${origLeft}px`;
                winEl.style.top = `${origTop}px`;
                updateWindowControls(winEl, false);
                startX = e.clientX;
                startY = e.clientY;
                return;
            }
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newTop = Math.max(0, Math.min(window.innerHeight - 72, origTop + dy));
            const newLeft = Math.max(-100, Math.min(window.innerWidth - 120, origLeft + dx));
            winEl.style.top = `${newTop}px`;
            winEl.style.left = `${newLeft}px`;

            if (winId !== 'win-confirm-modal') {
                if (!ghostOverlay) ghostOverlay = document.getElementById('snap-ghost-overlay');
                const screenW = window.innerWidth;
                const screenH = window.innerHeight - 40;

                const isNearLeft = e.clientX <= 16;
                const isNearRight = e.clientX >= screenW - 16;
                const isNearTop = e.clientY <= 16;
                const isNearBottom = e.clientY >= screenH - 24;

                if (isNearLeft && isNearTop) {
                    snapCandidate = 'top-left';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = '0px';
                        ghostOverlay.style.left = '0px';
                        ghostOverlay.style.width = '50vw';
                        ghostOverlay.style.height = 'calc((100vh - 40px) / 2)';
                        ghostOverlay.classList.add('active');
                    }
                } else if (isNearRight && isNearTop) {
                    snapCandidate = 'top-right';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = '0px';
                        ghostOverlay.style.left = '50vw';
                        ghostOverlay.style.width = '50vw';
                        ghostOverlay.style.height = 'calc((100vh - 40px) / 2)';
                        ghostOverlay.classList.add('active');
                    }
                } else if (isNearLeft && isNearBottom) {
                    snapCandidate = 'bottom-left';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = 'calc((100vh - 40px) / 2)';
                        ghostOverlay.style.left = '0px';
                        ghostOverlay.style.width = '50vw';
                        ghostOverlay.style.height = 'calc((100vh - 40px) / 2)';
                        ghostOverlay.classList.add('active');
                    }
                } else if (isNearRight && isNearBottom) {
                    snapCandidate = 'bottom-right';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = 'calc((100vh - 40px) / 2)';
                        ghostOverlay.style.left = '50vw';
                        ghostOverlay.style.width = '50vw';
                        ghostOverlay.style.height = 'calc((100vh - 40px) / 2)';
                        ghostOverlay.classList.add('active');
                    }
                } else if (isNearTop) {
                    snapCandidate = 'top';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = '0px';
                        ghostOverlay.style.left = '0px';
                        ghostOverlay.style.width = '100vw';
                        ghostOverlay.style.height = 'calc(100vh - 40px)';
                        ghostOverlay.classList.add('active');
                    }
                } else if (isNearLeft) {
                    snapCandidate = 'left';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = '0px';
                        ghostOverlay.style.left = '0px';
                        ghostOverlay.style.width = '50vw';
                        ghostOverlay.style.height = 'calc(100vh - 40px)';
                        ghostOverlay.classList.add('active');
                    }
                } else if (isNearRight) {
                    snapCandidate = 'right';
                    if (ghostOverlay) {
                        ghostOverlay.style.top = '0px';
                        ghostOverlay.style.left = '50vw';
                        ghostOverlay.style.width = '50vw';
                        ghostOverlay.style.height = 'calc(100vh - 40px)';
                        ghostOverlay.classList.add('active');
                    }
                } else {
                    snapCandidate = null;
                    if (ghostOverlay) ghostOverlay.classList.remove('active');
                }
            }
        });

        window.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            pendingRestore = false;
            if (ghostOverlay) ghostOverlay.classList.remove('active');

            if (snapCandidate && winId !== 'win-confirm-modal') {
                const targetSnap = snapCandidate === 'top' ? 'maximized' : snapCandidate;
                snapCandidate = null;
                applyWindowSnap(winEl, targetSnap);
            }
        });
    }

    function bindDesktopIconEvents(icon) {
        if (!icon || icon.dataset.bound === '1') return;
        icon.dataset.bound = '1';
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            closeConfirmModal();
            document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            icon.classList.add('selected');
        });
        icon.addEventListener('dblclick', () => {
            const target = icon.getAttribute('data-target');
            if (target) openWindow(target);
        });
    }

    function requestLogoutConfirmation() {
        openConfirmModal(
            '🚪 Confirm Logout',
            'Are you sure you want to log out of your <strong>A.R.I.S Web OS</strong> session?',
            handleLogout
        );
    }

    function initDesktopContextMenu() {
        const ctxMenu = document.getElementById('desktop-context-menu');
        const taskbarCtxMenu = document.getElementById('taskbar-context-menu');
        if (!ctxMenu) return;

        const savedIconSize = localStorage.getItem('aris_desktop_icon_size') || 'medium';
        applyDesktopIconSize(savedIconSize);

        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            if (Date.now() < suppressContextMenuUntil) {
                return;
            }

            const lockEl = document.getElementById('lock-screen');
            const loginEl = document.getElementById('login-screen');
            if (e.target.closest('#lock-screen') || e.target.closest('#login-screen') ||
                (lockEl && !lockEl.classList.contains('unlocked')) ||
                (loginEl && !loginEl.classList.contains('hidden'))) {
                ctxMenu.classList.add('hidden');
                if (taskbarCtxMenu) taskbarCtxMenu.classList.add('hidden');
                return;
            }

            const fromDesktopRightMarquee = (Date.now() - lastRightMarqueeAt) < 250;
            lastRightMarqueeAt = 0;
            if (e.target.closest('.window') && !fromDesktopRightMarquee) {
                ctxMenu.classList.add('hidden');
                if (taskbarCtxMenu) taskbarCtxMenu.classList.add('hidden');
                return;
            }

            if (e.target.closest('#taskbar')) {
                ctxMenu.classList.add('hidden');
                if (taskbarCtxMenu) {
                    const menuW = 160;
                    const menuH = 45;
                    let x = Math.min(e.clientX, window.innerWidth - menuW - 10);
                    let y = Math.max(5, e.clientY - menuH - 5);
                    taskbarCtxMenu.style.left = `${Math.max(5, x)}px`;
                    taskbarCtxMenu.style.top = `${y}px`;
                    taskbarCtxMenu.classList.remove('hidden');
                }
                return;
            }

            if (taskbarCtxMenu) taskbarCtxMenu.classList.add('hidden');
            const menuW = 210;
            const menuH = 150;
            let x = e.clientX;
            let y = e.clientY;

            if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 10;
            if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 10;

            ctxMenu.style.left = `${Math.max(5, x)}px`;
            ctxMenu.style.top = `${Math.max(5, y)}px`;
            ctxMenu.classList.remove('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#desktop-context-menu')) {
                ctxMenu.classList.add('hidden');
            }
            if (taskbarCtxMenu && !e.target.closest('#taskbar-context-menu')) {
                taskbarCtxMenu.classList.add('hidden');
            }
        });

        const btnTaskbarTaskMgr = document.getElementById('ctx-taskbar-taskmgr');
        if (btnTaskbarTaskMgr) {
            btnTaskbarTaskMgr.addEventListener('click', () => {
                if (taskbarCtxMenu) taskbarCtxMenu.classList.add('hidden');
                openWindow('win-taskmgr');
            });
        }

        const btnRefresh = document.getElementById('ctx-refresh');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', async () => {
                ctxMenu.classList.add('hidden');

                const iconsContainer = document.querySelector('.desktop-icons');
                if (iconsContainer) {
                    iconsContainer.classList.remove('desktop-refreshing');
                    void iconsContainer.offsetWidth;
                    iconsContainer.classList.add('desktop-refreshing');
                    setTimeout(() => {
                        iconsContainer.classList.remove('desktop-refreshing');
                    }, 200);
                }

                await refreshPlayerState();
            });
        }

        const btnTerm = document.getElementById('ctx-terminal');
        if (btnTerm) {
            btnTerm.addEventListener('click', () => {
                ctxMenu.classList.add('hidden');
                openWindow('win-terminal');
            });
        }

        document.querySelectorAll('#ctx-view-submenu [data-icon-size]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const size = item.getAttribute('data-icon-size');
                applyDesktopIconSize(size);
                localStorage.setItem('aris_desktop_icon_size', size);
                ctxMenu.classList.add('hidden');
            });
        });
    }

    function applyDesktopIconSize(size) {
        const container = document.querySelector('.desktop-icons');
        if (!container) return;
        container.classList.remove('icons-small', 'icons-medium', 'icons-large');
        container.classList.add(`icons-${size}`);

        ['small', 'medium', 'large'].forEach(s => {
            const chk = document.getElementById(`check-icon-${s}`);
            if (chk) chk.textContent = (s === size) ? '✓' : '';
        });
    }

    function initWindowControlsAndDragging() {
        document.querySelectorAll('.window').forEach(winEl => bindSingleWindowLifecycle(winEl));
        document.querySelectorAll('.desktop-icon').forEach(icon => bindDesktopIconEvents(icon));

        const confirmModalEl = document.getElementById('win-confirm-modal');
        if (confirmModalEl) {
            confirmModalEl.addEventListener('click', (e) => e.stopPropagation());
            confirmModalEl.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        const btnConfirmYes = document.getElementById('btn-confirm-yes');
        const btnConfirmNo = document.getElementById('btn-confirm-no');
        const btnConfirmClose = document.getElementById('btn-confirm-close');
        if (btnConfirmYes) {
            btnConfirmYes.addEventListener('click', async (e) => {
                e.stopPropagation();
                const cb = confirmModalCallback;
                closeConfirmModal();
                if (cb) await cb();
            });
        }
        if (btnConfirmNo) {
            btnConfirmNo.addEventListener('click', (e) => {
                e.stopPropagation();
                closeConfirmModal();
            });
        }
        if (btnConfirmClose) {
            btnConfirmClose.addEventListener('click', (e) => {
                e.stopPropagation();
                closeConfirmModal();
            });
        }

        const desktopEl = document.getElementById('desktop');
        const marqueeBox = document.getElementById('desktop-marquee-box');
        let isMarqueeDragging = false;
        let marqueeButton = 0;
        let leftDragMoved = false;
        let rightDragMoved = false;
        let suppressNextDesktopClick = false;
        let mStartX = 0, mStartY = 0;

        const stopMarqueeDrag = () => {
            if (!isMarqueeDragging) return;
            if (marqueeButton === 0 && leftDragMoved) {
                suppressNextDesktopClick = true;
                setTimeout(() => { suppressNextDesktopClick = false; }, 0);
            }
            if (marqueeButton === 2) {
                document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
                if (rightDragMoved) {
                    lastRightMarqueeAt = Date.now();
                }
            }
            isMarqueeDragging = false;
            leftDragMoved = false;
            rightDragMoved = false;
            document.body.classList.remove('is-marquee-selecting');
            if (marqueeBox) {
                marqueeBox.classList.add('hidden');
                marqueeBox.style.width = '0px';
                marqueeBox.style.height = '0px';
            }
        };

        if (desktopEl) {
            desktopEl.addEventListener('mousedown', (e) => {
                if (e.button !== 0 && e.button !== 2) return;
                if (e.target.closest('.window, .desktop-icon, .context-menu, #start-menu, #taskbar, .search-flyout, #taskbar-preview-card, .win-snap-flyout')) return;
                e.preventDefault();
                if (window.getSelection) {
                    try { window.getSelection().removeAllRanges(); } catch {}
                }
                isMarqueeDragging = true;
                marqueeButton = e.button;
                leftDragMoved = false;
                rightDragMoved = false;
                mStartX = e.clientX;
                mStartY = e.clientY;
                document.body.classList.add('is-marquee-selecting');
                document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            });

            desktopEl.addEventListener('click', (e) => {
                if (e.target.closest('#win-confirm-modal') || e.target.closest('.window')) return;
                closeConfirmModal(true);
                document.getElementById('start-menu').classList.add('hidden');
                if (suppressNextDesktopClick) {
                    suppressNextDesktopClick = false;
                    return;
                }
                document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            });
        }

        window.addEventListener('mousemove', (e) => {
            if (!isMarqueeDragging || !marqueeBox) return;
            const curX = e.clientX;
            const curY = e.clientY;
            const minX = Math.min(mStartX, curX);
            const minY = Math.min(mStartY, curY);
            const w = Math.abs(curX - mStartX);
            const h = Math.abs(curY - mStartY);

            if (w > 3 || h > 3) {
                if (marqueeButton === 0) leftDragMoved = true;
                if (marqueeButton === 2) rightDragMoved = true;
                if (window.getSelection) {
                    try { window.getSelection().removeAllRanges(); } catch {}
                }
                marqueeBox.classList.remove('hidden');
                marqueeBox.style.left = `${minX}px`;
                marqueeBox.style.top = `${minY}px`;
                marqueeBox.style.width = `${w}px`;
                marqueeBox.style.height = `${h}px`;

                const mRect = { left: minX, top: minY, right: minX + w, bottom: minY + h };
                document.querySelectorAll('.desktop-icon').forEach(icon => {
                    const r = icon.getBoundingClientRect();
                    const intersects = !(r.right < mRect.left || r.left > mRect.right || r.bottom < mRect.top || r.top > mRect.bottom);
                    icon.classList.toggle('selected', intersects);
                });
            }
        });

        window.addEventListener('mouseup', stopMarqueeDrag);
        window.addEventListener('blur', stopMarqueeDrag);
        window.addEventListener('contextmenu', stopMarqueeDrag, true);

        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            if (tag === 'input' && document.activeElement.id === 'cortana-input') return;
            const sm = document.getElementById('start-menu');
            if (sm && !sm.classList.contains('hidden')) { sm.classList.add('hidden'); return; }
            let closed = false;
            ['desktop-context-menu', 'taskbar-context-menu'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); closed = true; }
            });
            if (closed) return;
            const modalEl = document.getElementById('win-confirm-modal');
            if (modalEl && !modalEl.classList.contains('hidden')) closeConfirmModal();
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.repeat) {
                    e.preventDefault();
                    return;
                }
                const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || (document.activeElement && document.activeElement.isContentEditable)) return;
                const selected = document.querySelectorAll('.desktop-icon.selected');
                if (selected.length > 0) {
                    e.preventDefault();
                    selected.forEach(icon => {
                        const target = icon.getAttribute('data-target');
                        if (target) openWindow(target);
                        icon.classList.remove('selected');
                    });
                }
            }
        });

        initDesktopContextMenu();

        const startBtn = document.getElementById('start-btn');
        const startMenu = document.getElementById('start-menu');
        startBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeConfirmModal();
            startMenu.classList.toggle('hidden');
        });

        document.addEventListener('mousedown', (e) => {
            const sm = document.getElementById('start-menu');
            const sBtn = document.getElementById('start-btn');
            if (sm && !sm.classList.contains('hidden')) {
                if (!sm.contains(e.target) && (!sBtn || !sBtn.contains(e.target))) {
                    sm.classList.add('hidden');
                }
            }
        });

        document.querySelectorAll('[data-open]').forEach(el => {
            el.addEventListener('click', () => {
                const target = el.getAttribute('data-open');
                const targetTab = el.getAttribute('data-tab');
                startMenu.classList.add('hidden');
                if (target) openWindow(target, targetTab);
            });
        });

        const startBtnProfile = document.getElementById('start-btn-profile');
        if (startBtnProfile) {
            startBtnProfile.addEventListener('click', () => {
                startMenu.classList.add('hidden');
                openWindow('win-profile', 'stat');
            });
        }

        const startBtnSettings = document.getElementById('start-btn-settings');
        if (startBtnSettings) {
            startBtnSettings.addEventListener('click', () => {
                startMenu.classList.add('hidden');
                openWindow('win-settings');
            });
        }

        const startBtnLogout = document.getElementById('start-btn-logout');
        if (startBtnLogout) {
            startBtnLogout.addEventListener('click', (e) => {
                e.stopPropagation();
                startMenu.classList.add('hidden');
                requestLogoutConfirmation();
            });
        }

        let showDesktopPrevMinimized = [];
        const btnShowDesktop = document.getElementById('btn-show-desktop');
        if (btnShowDesktop) {
            btnShowDesktop.addEventListener('click', () => {
                closeConfirmModal();
                const visibleWins = Array.from(openWindows).filter(wId => {
                    const el = document.getElementById(wId);
                    return el && !el.classList.contains('hidden');
                });

                if (visibleWins.length > 0) {
                    showDesktopPrevMinimized = visibleWins;
                    visibleWins.forEach(wId => minimizeWindow(wId));
                } else if (showDesktopPrevMinimized.length > 0) {
                    showDesktopPrevMinimized.forEach(wId => openWindow(wId));
                    showDesktopPrevMinimized = [];
                }
            });
        }

        renderTaskbar();
    }

    function renderHardwareCounters() {
        const listEl = document.getElementById('hardware-counters-list');
        if (!listEl || !playerData) return;

        const u = playerData.user || {};
        const c = u.counters || playerData.counters || {};
        const activePots = playerData.activePotions || [];
        const hasCrystalMakerPot = activePots.some(p => p.id === 'pot_crystal_maker');

        const items = [];

        const nullCnt = Number(c.null_counter || 0);
        const nullPct = Math.min(100, Math.round((nullCnt / 19) * 100));
        items.push(`
            <div class="counter-item">
                <div class="counter-header">
                    <span class="counter-title">⬛ Reality Void NULL Counter</span>
                    <span class="counter-val">${nullCnt} / 19</span>
                </div>
                <div class="counter-bar-track">
                    <div class="counter-bar-fill" style="width: ${nullPct}%; background: linear-gradient(90deg, #a855f7, #6366f1);"></div>
                </div>
                <div class="counter-sub">1.404% chance on negative roll (every 19 rolls)</div>
            </div>
        `);

        const cmPity = Number(c.crystal_maker_pity || 0);
        if (hasCrystalMakerPot || cmPity > 0) {
            const cmPct = Math.min(100, Math.round((cmPity / 75) * 100));
            items.push(`
                <div class="counter-item">
                    <div class="counter-header">
                        <span class="counter-title">🧪 Crystal Maker Pity</span>
                        <span class="counter-val">${cmPity} / 75</span>
                    </div>
                    <div class="counter-bar-track">
                        <div class="counter-bar-fill" style="width: ${cmPct}%; background: linear-gradient(90deg, #00b4d8, #0077b6);"></div>
                    </div>
                    <div class="counter-sub">Guaranteed 1 Crystal at roll 75 (2% base chance)</div>
                </div>
            `);
        }

        if (u.equipped_module === 'mod_crystal') {
            const maxPity = u.equipped_chip === 'chip_crystal' ? 29 : 34;
            const cryPity = Number(c.crystal_module_pity || 0);
            const cryPct = Math.min(100, Math.round((cryPity / maxPity) * 100));
            items.push(`
                <div class="counter-item">
                    <div class="counter-header">
                        <span class="counter-title">💎 Crystal Module Pity</span>
                        <span class="counter-val">${cryPity} / ${maxPity}</span>
                    </div>
                    <div class="counter-bar-track">
                        <div class="counter-bar-fill" style="width: ${cryPct}%; background: linear-gradient(90deg, #06d6a0, #118ab2);"></div>
                    </div>
                    <div class="counter-sub">Guaranteed Crystal pity (${u.equipped_chip === 'chip_crystal' ? '3.5% + 29 Pity with Crystal Chip' : '3% + 34 Pity'})</div>
                </div>
            `);
        }

        listEl.innerHTML = items.join('');
    }

    const MAX_TELEMETRY_HISTORY = 1000;
    let telemetryHistory = [];
    let crosshairIndex = null;
    let lastLoadedTelemetryUser = null;

    window.telemetryState = window.telemetryState || {
        activeMetric: 'total',
        windowSize: 250,
        scaleMode: 'auto',
        paused: false,
        hoverIndex: -1
    };

    const TELEMETRY_CHANNELS = {
        total:    { key: 'total',     title: 'TOTAL LUCK TELEMETRY',       color: '#fcff61', unit: 'x',    format: (v) => `${fmtNum(v)}x` },
        basic:    { key: 'basic',     title: 'BASIC LUCK TELEMETRY',       color: '#03fc20', unit: '+',    format: (v) => `+${fmtNum(v)}` },
        multi:    { key: 'multi',     title: 'MULTI LUCK TELEMETRY',       color: '#034efc', unit: 'x',    format: (v) => `x${fmtNum(v)}` },
        special:  { key: 'special',   title: 'SPECIAL LUCK TELEMETRY',     color: '#ff26b3', unit: '+',    format: (v) => `${v >= 0 ? '+' : ''}${fmtNum(v)}` },
        final:    { key: 'final',     title: 'FINAL LUCK MULTIPLIER',      color: '#fcff61', unit: 'x',    format: (v) => `x${Number(v).toFixed(2)}` },
        cooldown: { key: 'cooldown',  title: 'ROLL COOLDOWN (SECONDS)',    color: '#00e5ff', unit: 's',    format: (v) => `${Number(v).toFixed(2)}s` }
    };
    TELEMETRY_CHANNELS.cd = TELEMETRY_CHANNELS.cooldown;
    const METRIC_CONFIGS = TELEMETRY_CHANNELS;

    function hexToRgba(hex, alpha = 1) {
        let c = String(hex || '#ffffff').replace('#', '');
        if (c.length === 3) c = c.split('').map(x => x + x).join('');
        const num = parseInt(c, 16) || 0;
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function safeParseNumeric(val) {
        if (typeof val === 'number') return isFinite(val) ? val : 0;
        if (typeof val === 'bigint') {
            const n = Number(val);
            return isFinite(n) ? n : 1e15;
        }
        if (typeof val === 'string') {
            const clean = val.trim();
            const n = parseFloat(clean);
            if (isFinite(n)) return n;
            return 0;
        }
        return 0;
    }

    function safeLog10(val) {
        if (val === null || val === undefined) return 0;
        if (typeof val === 'number') {
            if (val <= 0 || !isFinite(val)) return 0;
            return Math.log10(val);
        }
        if (typeof val === 'bigint') {
            if (val <= 0n) return 0;
            const s = val.toString();
            const firstDigits = parseFloat(s.slice(0, 6));
            return (s.length - 1) + Math.log10(Math.max(1, firstDigits) / Math.pow(10, Math.min(5, s.length - 1)));
        }
        const s = String(val).trim().replace(/^[+-]/, '');
        if (!s || s === '0') return 0;
        const n = parseFloat(s);
        if (isFinite(n) && n > 0 && n < 1e300) {
            return Math.log10(n);
        }
        const firstDigits = parseFloat(s.slice(0, 6));
        return (s.length - 1) + Math.log10(Math.max(1, firstDigits) / Math.pow(10, Math.min(5, s.length - 1)));
    }

    function loadTelemetryHistory() {
        if (!currentUserId) return;
        if (lastLoadedTelemetryUser === currentUserId && telemetryHistory.length > 0) return;
        lastLoadedTelemetryUser = currentUserId;
        try {
            const raw = localStorage.getItem(`aris_telemetry_${currentUserId}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    telemetryHistory = parsed.slice(-MAX_TELEMETRY_HISTORY);
                    return;
                }
            }
        } catch (e) {}
        telemetryHistory = [];
    }

    function saveTelemetryHistory() {
        if (!currentUserId) return;
        try {
            localStorage.setItem(`aris_telemetry_${currentUserId}`, JSON.stringify(telemetryHistory.slice(-MAX_TELEMETRY_HISTORY)));
        } catch (e) {}
    }

    function recordTelemetryPoint(stats, rollResult = null) {
        if (!stats) return;
        loadTelemetryHistory();

        let rollNum = (playerData?.user?.total_rolls) ? Number(playerData.user.total_rolls) : (telemetryHistory.length + 1);
        let rollValNum = 0;
        let formattedRoll = '1';
        let isNegative = false;

        if (rollResult) {
            formattedRoll = rollResult.formattedRoll || String(rollResult.roll || '1');
            isNegative = Boolean(rollResult.isNegative);
            const cleanRoll = String(rollResult.roll || '0').replace('-', '');
            rollValNum = safeParseNumeric(cleanRoll);
            if (isNegative) rollValNum = -rollValNum;
        } else if (telemetryHistory.length > 0) {
            const last = telemetryHistory[telemetryHistory.length - 1];
            rollValNum = last.rollValue ?? last.roll ?? 0;
            formattedRoll = last.formattedRoll || '1';
            isNegative = Boolean(last.isNegative);
        }

        const totalLuck = typeof stats.finalLuck === 'number' ? stats.finalLuck : (parseFloat(stats.finalLuck) || 1);
        const basicLuck = typeof stats.basic === 'number' ? stats.basic : (parseFloat(stats.basic) || 0);
        const multiLuck = typeof stats.multi === 'number' ? stats.multi : (parseFloat(stats.multi) || 1);
        const specialLuck = typeof stats.special === 'number' ? stats.special : (parseFloat(stats.special) || 0);
        const finalLuck = typeof stats.finalMult === 'number'
            ? stats.finalMult
            : (stats.final !== undefined ? ((1.0 + Number(stats.final || 0)) * Number(stats.final_multiplier || 1)) : 1);
        const cd = typeof stats.finalCd === 'number'
            ? stats.finalCd
            : (typeof stats.cd === 'number' ? stats.cd : (parseFloat(stats.finalCd || stats.cd) || 10));

        let isSpike = false;
        if (telemetryHistory.length >= 3) {
            const recent = telemetryHistory.slice(-10);
            const avgRecentTotal = recent.reduce((acc, p) => acc + (p.total || 1), 0) / recent.length;
            if (totalLuck > avgRecentTotal * 5 && totalLuck >= 50) {
                isSpike = true;
            }
        }

        const point = {
            ts: Date.now(),
            rollNum,
            total: totalLuck,
            basic: basicLuck,
            multi: multiLuck,
            special: specialLuck,
            final: finalLuck,
            cooldown: cd,
            cd: cd,
            rollValue: rollValNum,
            roll: rollValNum,
            isNegative,
            isSpike,
            formattedRoll
        };

        telemetryHistory.push(point);
        if (telemetryHistory.length > MAX_TELEMETRY_HISTORY) {
            telemetryHistory.shift();
        }
        saveTelemetryHistory();
    }

    function exportTelemetryData(format = 'json') {
        loadTelemetryHistory();
        if (telemetryHistory.length === 0) {
            if (typeof showWinToast === 'function') showWinToast('No telemetry data to export.', 'info');
            return;
        }
        let content, mime, ext;
        if (format === 'json') {
            content = JSON.stringify(telemetryHistory, null, 2);
            mime = 'application/json';
            ext = 'json';
        } else {
            const headers = ['ts', 'rollNum', 'total', 'basic', 'multi', 'special', 'final', 'cooldown', 'rollValue', 'isNegative', 'isSpike', 'formattedRoll'];
            const rows = telemetryHistory.map(pt => headers.map(h => JSON.stringify(pt[h] ?? '')).join(','));
            content = [headers.join(','), ...rows].join('\n');
            mime = 'text/csv';
            ext = 'csv';
        }
        try {
            const blob = new Blob([content], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `aris_telemetry_${currentUserId || 'guest'}_${Date.now()}.${ext}`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 500);
            if (typeof showWinToast === 'function') showWinToast(`Telemetry data exported (${ext.toUpperCase()})`, 'success');
        } catch (e) {
            if (typeof showWinToast === 'function') showWinToast('Failed to export telemetry: ' + e.message, 'error');
        }
    }

    function injectSimTelemetry100x() {
        const isDev = Boolean(isDevAccount || playerData?.user?.isDev);
        if (!isDev) {
            if (typeof showWinToast === 'function') showWinToast('🔒 Developer access required for telemetry injection.', 'warning');
            return;
        }
        loadTelemetryHistory();
        let curRollNum = (playerData?.user?.total_rolls ? Number(playerData.user.total_rolls) : telemetryHistory.length) + 1;
        const now = Date.now();

        for (let i = 0; i < 100; i++) {
            const basic = Math.floor(Math.sin(i / 5) * 15 + 16);
            const multi = parseFloat((1.0 + (i % 10) * 0.45).toFixed(2));
            let special = (i % 15 === 0) ? 80000 : (i % 7 === 0 ? 15000 : (i % 4 === 0 ? 2000 : 0));
            const isNeg = (i === 13 || i === 47 || i === 81);
            if (isNeg) special = -200000;

            const finalMult = (i % 12 === 0) ? 2.5 : ((i % 6 === 0) ? 1.5 : 1.0);
            const cd = parseFloat(Math.max(1.0, 10.0 - (i % 9) * 0.9).toFixed(2));

            const total = Math.max(1, Math.round((((1 + basic) * multi) + special) * finalMult));

            const uRnd = Math.random();
            const rVal = Math.max(1, Math.floor(total / Math.max(0.0001, uRnd)));
            const finalRVal = isNeg ? -rVal : rVal;
            const isSpike = special > 10000;

            telemetryHistory.push({
                ts: now - (100 - i) * 1500,
                rollNum: curRollNum++,
                total: total,
                basic: basic,
                multi: multi,
                special: special,
                final: finalMult,
                cooldown: cd,
                cd: cd,
                rollValue: finalRVal,
                roll: finalRVal,
                isNegative: isNeg,
                isSpike: isSpike,
                formattedRoll: fmtNum(rVal)
            });
        }
        if (telemetryHistory.length > MAX_TELEMETRY_HISTORY) {
            telemetryHistory = telemetryHistory.slice(-MAX_TELEMETRY_HISTORY);
        }
        saveTelemetryHistory();
        updateTaskMgrGraph();
        if (typeof showWinToast === 'function') {
            showWinToast('Injected 100 varied simulated telemetry points!', 'success');
        }
    }

    function clearTelemetryBuffer() {
        telemetryHistory = [];
        if (currentUserId) {
            localStorage.removeItem(`aris_telemetry_${currentUserId}`);
        }
        updateTaskMgrGraph();
        if (typeof showWinToast === 'function') {
            showWinToast('Telemetry buffer cleared.', 'info');
        }
    }

    function showTelemetryTooltip(e, mouseX, pt) {
        const tooltipEl = document.getElementById('taskmgr-hud-tooltip');
        if (!tooltipEl || !pt) return;
        const state = window.telemetryState || { activeMetric: 'total' };
        const cfg = TELEMETRY_CHANNELS[state.activeMetric] || TELEMETRY_CHANNELS.total;
        const metricVal = pt[cfg.key];
        const timeStr = pt.ts ? new Date(pt.ts).toLocaleTimeString() : 'N/A';
        const rollDisplay = pt.formattedRoll || (pt.rollValue !== undefined ? fmtNum(Math.abs(pt.rollValue)) : '0');

        tooltipEl.innerHTML = `
            <div class="hud-tooltip-header">
                <strong>Roll #${pt.rollNum || '?'}</strong>
                <span class="hud-time">${escapeHtml(timeStr)}</span>
            </div>
            <div class="hud-tooltip-body">
                <div>🎲 Rarity: <strong style="color:#d580ff;">1 in ${escapeHtml(rollDisplay)}</strong></div>
                <div>⚡ Total Luck: <strong style="color:#fcff61;">${fmtNum(pt.total || 1)}x</strong></div>
                <div>${escapeHtml(cfg.title)}: <strong style="color:${cfg.color};">${cfg.format(metricVal, pt)}</strong></div>
                ${pt.isNegative ? '<div style="color:#ff0055;font-weight:700;">⚠️ NEGATIVE ROLL (NULL)</div>' : ''}
                ${pt.isSpike ? '<div style="color:#fcff61;font-weight:700;">✨ LUCK SPIKE TRIGGERED</div>' : ''}
            </div>
        `;
        tooltipEl.classList.remove('hidden');

        const wrapW = tooltipEl.parentElement ? tooltipEl.parentElement.clientWidth : 380;
        let leftPos = mouseX + 12;
        if (leftPos + 180 > wrapW) {
            leftPos = Math.max(5, mouseX - 185);
        }
        tooltipEl.style.left = `${leftPos}px`;
        tooltipEl.style.top = '10px';
    }

    function updateTaskMgrGraph() {
        loadTelemetryHistory();
        const state = window.telemetryState;
        if (!state) return;
        if (state.activeMetric === 'cd') state.activeMetric = 'cooldown';
        const cfg = TELEMETRY_CHANNELS[state.activeMetric] || TELEMETRY_CHANNELS.total;

        document.querySelectorAll('#taskmgr-metric-sidebar [data-metric], .taskmgr-metric-list [data-metric]').forEach(item => {
            const m = item.getAttribute('data-metric');
            const isAct = (m === state.activeMetric) || (m === 'cd' && state.activeMetric === 'cooldown');
            item.classList.toggle('active', isAct);
            if (isAct) {
                item.style.borderLeftColor = cfg.color;
            } else {
                item.style.borderLeftColor = 'transparent';
            }
        });

        const scaleBtn = document.getElementById('btn-telemetry-scale');

        const activeLabelEl = document.getElementById('taskmgr-active-metric-label');
        if (activeLabelEl) activeLabelEl.textContent = cfg.title;

        const graphTitleEl = document.getElementById('taskmgr-graph-title');
        if (graphTitleEl) {
            graphTitleEl.textContent = cfg.title;
            graphTitleEl.style.color = cfg.color;
        }

        const graphCardEl = document.getElementById('taskmgr-graph-card');
        if (graphCardEl) {
            graphCardEl.style.borderColor = hexToRgba(cfg.color, 0.4);
            graphCardEl.style.boxShadow = `inset 0 0 16px ${hexToRgba(cfg.color, 0.08)}`;
        }

        const slice = telemetryHistory.slice(-state.windowSize);
        const displayedCount = slice.length;
        const totalCount = telemetryHistory.length;

        const bufferEl = document.getElementById('taskmgr-graph-stats');
        if (bufferEl) {
            bufferEl.textContent = `Buffer: ${totalCount}/${MAX_TELEMETRY_HISTORY} Rolls${displayedCount < totalCount ? ` (last ${displayedCount})` : ''}`;
        }

        const statTotalLuckEl = document.getElementById('stat-total-luck');
        const minEl = document.getElementById('taskmgr-min-val');
        const avgEl = document.getElementById('taskmgr-avg-val');
        const maxEl = document.getElementById('taskmgr-max-val');
        const curEl = document.getElementById('taskmgr-cur-val');
        const devEvEl = document.getElementById('dev-stat-ev');
        const devMedianEl = document.getElementById('dev-stat-median');
        const devConvEl = document.getElementById('dev-stat-conv');
        const devVelEl = document.getElementById('dev-stat-velocity');

        if (totalCount === 0 || displayedCount === 0) {
            if (statTotalLuckEl) {
                statTotalLuckEl.textContent = '0';
                statTotalLuckEl.style.color = cfg.color;
            }
            if (minEl) minEl.textContent = '0';
            if (avgEl) avgEl.textContent = '0';
            if (maxEl) maxEl.textContent = '0';
            if (curEl) {
                curEl.textContent = '-';
                curEl.style.color = cfg.color;
            }
            if (devEvEl) devEvEl.textContent = '--';
            if (devMedianEl) devMedianEl.textContent = '--';
            if (devConvEl) devConvEl.textContent = '--';
            if (devVelEl) devVelEl.textContent = '0 rpm';
            if (scaleBtn) scaleBtn.textContent = 'SCALE: AUTO';
            renderTaskMgrCanvas();
            return;
        }

        const rawSeries = slice.map(item => {
            const v = item[cfg.key];
            return typeof v === 'number' ? v : (parseFloat(v) || 0);
        });

        let minVal = rawSeries[0];
        let maxVal = rawSeries[0];
        let sum = 0;
        for (let i = 0; i < displayedCount; i++) {
            const v = rawSeries[i];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
            sum += v;
        }
        const avgVal = displayedCount > 0 ? (sum / displayedCount) : 0;
        const curVal = displayedCount > 0 ? rawSeries[displayedCount - 1] : 0;
        const latestPt = slice[displayedCount - 1];

        if (statTotalLuckEl) {
            statTotalLuckEl.textContent = cfg.format(curVal, latestPt);
            statTotalLuckEl.style.color = cfg.color;
        }
        if (minEl) minEl.textContent = cfg.format(minVal, slice[rawSeries.indexOf(minVal)]);
        if (avgEl) avgEl.textContent = cfg.format(avgVal);
        if (maxEl) maxEl.textContent = cfg.format(maxVal, slice[rawSeries.indexOf(maxVal)]);
        if (curEl) {
            curEl.textContent = cfg.format(curVal, latestPt);
            curEl.style.color = cfg.color;
        }

        const isWide = maxVal > 0 && minVal >= 0 && (maxVal / Math.max(1, minVal) > 1000);
        const isLog10 = state.scaleMode === 'log10' || (state.scaleMode === 'auto' && isWide);
        if (scaleBtn) {
            scaleBtn.textContent = state.scaleMode === 'auto'
                ? (isLog10 ? 'SCALE: LOG10 (AUTO)' : 'SCALE: LIN (AUTO)')
                : (state.scaleMode === 'log10' ? 'SCALE: LOG10' : 'SCALE: LIN');
        }

        if (devEvEl) {
            const evVal = slice.reduce((s, p) => s + (p.total || 1), 0) / displayedCount;
            devEvEl.textContent = `${fmtNum(evVal)}x`;
            if (devMedianEl) {
                const sortedRolls = slice.map(p => Math.abs(p.rollValue || 0)).sort((a, b) => a - b);
                const medVal = sortedRolls[Math.floor(sortedRolls.length / 2)] || 0;
                devMedianEl.textContent = `1 in ${fmtNum(medVal)}`;
            }
            if (devConvEl) {
                const meanRoll = slice.reduce((s, p) => s + Math.abs(p.rollValue || 0), 0) / displayedCount;
                const conv = evVal > 0 ? (meanRoll / evVal) : 1;
                devConvEl.textContent = `${(conv * 100).toFixed(0)}%`;
                devConvEl.style.color = (conv >= 0.7 && conv <= 1.3) ? '#4ade80' : '#f59e0b';
            }
        }
        if (devVelEl) {
            if (displayedCount >= 2) {
                const tSpanMin = Math.max(0.05, (slice[displayedCount - 1].ts - slice[0].ts) / 60000);
                const rpm = (displayedCount / tSpanMin).toFixed(1);
                devVelEl.textContent = `${rpm} rpm`;
            } else {
                devVelEl.textContent = '0 rpm';
            }
        }

        renderTaskMgrCanvas();
    }

    function renderTaskMgrCanvas() {
        const canvas = document.getElementById('taskmgr-luck-canvas');
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 380;
        const cssW = Math.max(200, parentW);
        const cssH = 110;

        const targetW = Math.round(cssW * dpr);
        const targetH = Math.round(cssH * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
            canvas.style.width = `${cssW}px`;
            canvas.style.height = `${cssH}px`;
        }

        if (dpr !== 1 && typeof ctx.setTransform === 'function') {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        const w = cssW;
        const h = cssH;

        ctx.fillStyle = '#081318';
        ctx.fillRect(0, 0, w, h);

        const state = window.telemetryState || { activeMetric: 'total', windowSize: 250, scaleMode: 'auto', hoverIndex: -1 };
        const cfg = TELEMETRY_CHANNELS[state.activeMetric] || TELEMETRY_CHANNELS.total;

        ctx.strokeStyle = hexToRgba(cfg.color, 0.12);
        ctx.lineWidth = 1;
        const gridCols = 10;
        const gridRows = 5;
        for (let c = 1; c < gridCols; c++) {
            const x = (w / gridCols) * c;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let r = 1; r < gridRows; r++) {
            const y = (h / gridRows) * r;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        const slice = telemetryHistory.slice(-state.windowSize);
        const displayedCount = slice.length;

        if (displayedCount === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '12px "Segoe UI", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("No roll telemetry recorded yet — Press Roll to begin", w / 2, h / 2);
            return;
        }

        const rawSeries = slice.map(item => {
            const v = item[cfg.key];
            return typeof v === 'number' ? v : (parseFloat(v) || 0);
        });

        let minVal = rawSeries[0];
        let maxVal = rawSeries[0];
        for (let i = 0; i < displayedCount; i++) {
            const v = rawSeries[i];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
        }

        const isWide = maxVal > 0 && minVal >= 0 && (maxVal / Math.max(1, minVal) > 1000);
        const isLog10 = state.scaleMode === 'log10' || (state.scaleMode === 'auto' && isWide);

        const padTop = 10;
        const padBottom = 16;
        const availH = h - padTop - padBottom;

        let pts = [];
        if (!isLog10) {
            let plotMin = minVal;
            let plotMax = maxVal;
            if (plotMin === plotMax) {
                plotMin -= (plotMin === 0 ? 1 : Math.abs(plotMin) * 0.2);
                plotMax += (plotMax === 0 ? 1 : Math.abs(plotMax) * 0.2);
            }
            const range = Math.max(1e-9, plotMax - plotMin);
            pts = rawSeries.map((val, idx) => {
                const x = displayedCount <= 1 ? (w / 2) : (idx / (displayedCount - 1)) * w;
                const norm = Math.max(0, Math.min(1, (val - plotMin) / range));
                const y = padTop + (1 - norm) * availH;
                return { x, y };
            });
        } else {
            const logMin = safeLog10(Math.max(1, minVal));
            const logMax = safeLog10(Math.max(10, maxVal));
            const logRange = Math.max(0.1, logMax - logMin);
            pts = rawSeries.map((val, idx) => {
                const lVal = safeLog10(Math.max(1, val));
                const norm = Math.max(0, Math.min(1, (lVal - logMin) / logRange));
                const x = displayedCount <= 1 ? (w / 2) : (idx / (displayedCount - 1)) * w;
                const y = padTop + (1 - norm) * availH;
                return { x, y };
            });
        }

        if (pts.length > 0) {
            const fillPts = pts.length === 1 ? [{ x: 0, y: pts[0].y }, { x: w, y: pts[0].y }] : pts;

            ctx.beginPath();
            ctx.moveTo(fillPts[0].x, h);
            fillPts.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.lineTo(fillPts[fillPts.length - 1].x, h);
            ctx.closePath();
            try {
                const grad = ctx.createLinearGradient(0, 0, 0, h);
                grad.addColorStop(0, hexToRgba(cfg.color, 0.45));
                grad.addColorStop(1, hexToRgba(cfg.color, 0.02));
                ctx.fillStyle = grad;
                ctx.fill();
            } catch (e) {}

            ctx.beginPath();
            ctx.moveTo(fillPts[0].x, fillPts[0].y);
            for (let i = 1; i < fillPts.length; i++) {
                ctx.lineTo(fillPts[i].x, fillPts[i].y);
            }
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth = 2;
            ctx.stroke();

            for (let i = 0; i < displayedCount; i++) {
                const pt = slice[i];
                const p = pts[i];
                if (pt.isNegative) {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                    ctx.fillStyle = '#ff0055';
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                } else if (pt.isSpike) {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
                    ctx.fillStyle = '#fcff61';
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }

            const lastP = pts[pts.length - 1];
            ctx.beginPath();
            ctx.arc(lastP.x, lastP.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth = 2;
            ctx.stroke();

            const hIdx = state.hoverIndex !== undefined ? state.hoverIndex : crosshairIndex;
            if (hIdx !== null && hIdx >= 0 && hIdx < pts.length) {
                const cp = pts[hIdx];
                ctx.beginPath();
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
                ctx.lineWidth = 1;
                ctx.moveTo(cp.x, 0);
                ctx.lineTo(cp.x, h);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.beginPath();
                ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
                ctx.fillStyle = cfg.color;
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    function handleGlobalTelemetryClick(e) {
        const metricCard = e.target.closest('#taskmgr-metric-sidebar [data-metric], .taskmgr-metric-list [data-metric]');
        if (metricCard) {
            let m = metricCard.getAttribute('data-metric');
            if (m === 'cd') m = 'cooldown';
            if (TELEMETRY_CHANNELS[m]) {
                if (window.telemetryState) {
                    window.telemetryState.activeMetric = m;
                }
                updateTaskMgrGraph();
                return;
            }
        }

        const actionBtn = e.target.closest('[data-telemetry-action]');
        if (actionBtn && window.telemetryState) {
            const act = actionBtn.getAttribute('data-telemetry-action');
            if (act === 'toggle-scale') {
                const modes = ['auto', 'log10', 'linear'];
                const curIdx = modes.indexOf(window.telemetryState.scaleMode);
                window.telemetryState.scaleMode = modes[(curIdx + 1) % modes.length];
                updateTaskMgrGraph();
            }
            return;
        }
    }
    document.addEventListener('click', handleGlobalTelemetryClick);

    async function handleGlobalAppClick(e) {
        const lockBtn = e.target.closest('.btn-lock-roll');
        if (lockBtn) {
            e.stopPropagation();
            const rollId = lockBtn.getAttribute('data-id');
            await apiPost('/api/inventory/lock', { userId: currentUserId, rollId });
            await refreshPlayerState();
            return;
        }
        const sellBtn = e.target.closest('.btn-sell-roll');
        if (sellBtn && !sellBtn.disabled) {
            e.stopPropagation();
            const rollId = sellBtn.getAttribute('data-id');
            await apiPost('/api/inventory/sell', { userId: currentUserId, rollId });
            await refreshPlayerState();
            return;
        }

        const usePotBtn = e.target.closest('.btn-inv-use-pot');
        if (usePotBtn) {
            e.stopPropagation();
            const itemId = usePotBtn.getAttribute('data-id');
            const qty = usePotBtn.getAttribute('data-qty');
            const res = await apiPost('/api/shop/use', { userId: currentUserId, itemId, qty });
            const cleanMsg = (res.message || '').replace(/\*\*/g, '');
            const fb = document.getElementById('inv-pot-feedback');
            if (fb) fb.textContent = cleanMsg;
            if (res.ok) {
                showWinToast(cleanMsg || 'Potion consumed successfully!', 'info', 'Potion Consumed');
            } else {
                showWinToast(cleanMsg || 'Could not use potion.', 'error', 'Potion Error');
            }
            await refreshPlayerState();
            return;
        }

        const equipHwBtn = e.target.closest('.btn-inv-equip-hw');
        if (equipHwBtn) {
            e.stopPropagation();
            const itemId = equipHwBtn.getAttribute('data-id');
            const type = equipHwBtn.getAttribute('data-type');
            const res = await apiPost('/api/inventory/equip', { userId: currentUserId, itemId, type });
            const cleanMsg = (res.message || (res.ok ? `Updated ${type} equipment!` : 'Error')).replace(/\*\*/g, '');
            const fb = document.getElementById('inv-hw-feedback');
            if (fb) fb.textContent = cleanMsg;
            if (res.ok) {
                showWinToast(cleanMsg, 'info', 'Hardware Updated');
            } else {
                showWinToast(cleanMsg, 'error', 'Hardware Error');
            }
            await refreshPlayerState();
            return;
        }

        const equipAchBtn = e.target.closest('.btn-equip-ach');
        if (equipAchBtn) {
            e.stopPropagation();
            const achId = equipAchBtn.getAttribute('data-id');
            const res = await apiPost('/api/achieve/equip', { userId: currentUserId, achId });
            const fb = document.getElementById('ach-feedback');
            if (fb) fb.textContent = res.message || '';
            await refreshPlayerState();
            return;
        }

        const equipTitleBtn = e.target.closest('.btn-equip-title');
        if (equipTitleBtn) {
            e.stopPropagation();
            const titleId = equipTitleBtn.getAttribute('data-id');
            const res = await apiPost('/api/title/equip', { userId: currentUserId, titleId });
            const fb = document.getElementById('title-feedback');
            if (fb) fb.textContent = res.message || '';
            await refreshPlayerState();
            return;
        }

        const questClaimBtn = e.target.closest('.btn-quest-claim');
        if (questClaimBtn && !questClaimBtn.disabled) {
            e.stopPropagation();
            const questIndex = Number(questClaimBtn.getAttribute('data-idx'));
            const res = await apiPost('/api/quest/claim', { userId: currentUserId, questIndex });
            const fb = document.getElementById('quest-feedback');
            if (fb) fb.textContent = res.message || '';
            await refreshPlayerState();
            return;
        }
        const questRerollBtn = e.target.closest('.btn-quest-reroll');
        if (questRerollBtn && !questRerollBtn.disabled) {
            e.stopPropagation();
            const questIndex = Number(questRerollBtn.getAttribute('data-idx'));
            const res = await apiPost('/api/quest/reroll', { userId: currentUserId, questIndex });
            const fb = document.getElementById('quest-feedback');
            if (fb) fb.textContent = res.message || '';
            await refreshPlayerState();
            return;
        }

        const shopRow = e.target.closest('.shop-item-row');
        if (shopRow && shopRow.dataset.itemId) {
            selectedShopItemId = shopRow.dataset.itemId;
            renderShopList();
            renderShopInspector(selectedShopItemId);
            return;
        }

        const qshopBtn = e.target.closest('[data-qshop-buy]');
        if (qshopBtn) {
            e.stopPropagation();
            const shopIndex = qshopBtn.getAttribute('data-qshop-buy');
            const label = qshopBtn.getAttribute('data-qshop-label') || qshopBtn.textContent.trim();
            openConfirmModal(
                '🎫 Confirm Token Shop Purchase',
                `Are you sure you want to purchase <strong>${label}</strong> using your Quest Tokens?`,
                async () => {
                    const res = await apiPost('/api/quest/buy', { userId: currentUserId, shopIndex });
                    document.getElementById('quest-feedback').textContent = res.message || '';
                    if (res.ok) {
                        showWinToast(res.message || 'Purchased item from Quest Token Shop!', 'info', 'Quest Store');
                    } else {
                        showWinToast(res.message || 'Purchase failed.', 'error', 'Quest Store');
                    }
                    await refreshPlayerState();
                }
            );
            return;
        }
    }
    document.addEventListener('click', handleGlobalAppClick);

    function updateLuckGraph() {
        updateTaskMgrGraph();
    }

    function updateAllViews() {
        if (!playerData) return;
        const { user, stats, activePotions, inventory, expandCost, settings, missionHub } = playerData;

        applyOsVisualPreferences(settings);

        const setCurrencyPill = (id, label, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = fmtCurrency(val);
            if (el.parentElement) {
                el.parentElement.title = `${label}: ${fmtNum(val)}`;
            }
        };

        setCurrencyPill('top-coins', 'Coins', user.coins);
        setCurrencyPill('top-crystals', 'Crystals', user.crystals);
        setCurrencyPill('top-nulls', 'NULL', user.nulls);
        setCurrencyPill('top-cc', 'Compressed Crystals (CC)', user.cc_coins);
        setCurrencyPill('top-tokens', 'Quest Tokens', user.quest_tokens || 0);

        setCurrencyPill('inv-coins', 'Coins', user.coins);
        setCurrencyPill('inv-crystals', 'Crystals', user.crystals);
        setCurrencyPill('inv-nulls', 'NULL', user.nulls);
        setCurrencyPill('inv-cc', 'Compressed Crystals (CC)', user.cc_coins);
        setCurrencyPill('inv-tokens', 'Quest Tokens', user.quest_tokens || 0);

        setCurrencyPill('shop-coins', 'Coins', user.coins);
        setCurrencyPill('shop-crystals', 'Crystals', user.crystals);
        setCurrencyPill('shop-nulls', 'NULL', user.nulls);
        setCurrencyPill('shop-cc', 'Compressed Crystals (CC)', user.cc_coins);

        const inspectingOther = authUserId && currentUserId !== authUserId;
        const formattedUserTitle = (user.username || `User_${String(user.id).slice(0, 4)}`) +
            (inspectingOther ? ' [INSPECTING]' : (isDevAccount ? ' [DEV]' : ''));

        const topUserEl = document.getElementById('top-username');
        if (topUserEl) topUserEl.textContent = formattedUserTitle;

        const invUserEl = document.getElementById('inv-top-username');
        if (invUserEl) invUserEl.textContent = formattedUserTitle;

        const loginUserEl = document.getElementById('login-display-name');
        if (loginUserEl && user.username) {
            loginUserEl.textContent = user.username;
        }

        const devReturnBar = document.getElementById('dev-return-bar');
        if (devReturnBar) {
            devReturnBar.style.display = inspectingOther ? 'flex' : 'none';
        }

        const tileRollsSub = document.getElementById('tile-rolls-sub');
        if (tileRollsSub) tileRollsSub.textContent = `${fmtNum(user.total_rolls)} Total Rolls`;
        const tileLuckVal = document.getElementById('tile-luck-val');
        if (tileLuckVal) tileLuckVal.textContent = `x${fmtNum(stats.finalLuck)}`;

        document.getElementById('roll-best-pos').textContent = `1 in ${fmtNum(user.highest_pos)}`;
        document.getElementById('roll-best-neg').textContent = user.lowest_neg && user.lowest_neg !== '0'
            ? `1 in ${fmtNum(user.lowest_neg)}`
            : 'None';
        document.getElementById('roll-total-count').textContent = fmtNum(user.total_rolls);

        const autoBtn = document.getElementById('btn-auto-roll');
        if (!user.has_auto_chip) {
            if (autoRollActive) {
                autoRollActive = false;
                autoBtn.classList.remove('primary');
            }
            autoBtn.textContent = '🔒 Auto-Roll (Need Chip)';
        } else {
            autoBtn.textContent = autoRollActive ? `🤖 Auto: ON (${autoRollBatchCount}/1337)` : '🤖 Auto-Roll: OFF';
        }

        document.getElementById('stat-basic').textContent = `+${fmtNum(stats.basic)} (+1 base)`;
        document.getElementById('stat-multi').textContent = `x${fmtNum(stats.multi)}`;
        document.getElementById('stat-special').textContent = `${stats.special >= 0 ? '+' : ''}${fmtNum(stats.special)}`;
        document.getElementById('stat-final').textContent = `x${stats.finalMult.toFixed(2)}`;
        document.getElementById('stat-cooldown').textContent = `${stats.finalCd.toFixed(2)}s`;

        const totalPrevEl = document.getElementById('stat-total-preview');
        if (totalPrevEl) totalPrevEl.textContent = `${fmtNum(stats.finalLuck)}x`;
        const cdPrevEl = document.getElementById('stat-cd-preview');
        if (cdPrevEl) cdPrevEl.textContent = `${stats.finalCd.toFixed(2)}s`;

        const modNameEl = document.getElementById('stat-mod-name');
        if (modNameEl) {
            const modId = user.equipped_module;
            const modDef = modId && shopCatalog?.modules ? shopCatalog.modules[modId] : null;
            modNameEl.textContent = modDef?.name || modId || 'None';
        }
        const chipNameEl = document.getElementById('stat-chip-name');
        if (chipNameEl) {
            const chipId = user.equipped_chip;
            const chipDef = chipId && shopCatalog?.chips ? shopCatalog.chips[chipId] : null;
            chipNameEl.textContent = chipDef?.name || chipId || 'None';
        }

        if (user && stats) {
            const currentTotalRolls = Number(user.total_rolls || 0);
            if (telemetryHistory.length > 0) {
                const lastPoint = telemetryHistory[telemetryHistory.length - 1];
                if (lastPoint.rollNum && currentTotalRolls > lastPoint.rollNum) {
                    const lastVal = user.last_roll_val || '0';
                    recordTelemetryPoint(stats, {
                        roll: lastVal,
                        formattedRoll: fmtNum(lastVal),
                        isNegative: String(lastVal).startsWith('-')
                    });
                }
            }
        }

        updateTaskMgrGraph();

        renderHardwareCounters();

        document.getElementById('active-pot-count').textContent = activePotions.length;
        const potProcCountEl = document.getElementById('active-pot-proc-count');
        if (potProcCountEl) potProcCountEl.textContent = activePotions.length;
        const potContainer = document.getElementById('active-potions-list');
        potContainer.innerHTML = '';
        if (activePotions.length === 0) {
            potContainer.innerHTML = '<div class="empty-hint" style="padding:12px;">No active potions. Consume potions from Shop or Inventory!</div>';
        } else {
            activePotions.forEach(p => {
                const row = document.createElement('div');
                row.className = 'active-pot-row';
                row.innerHTML = `
                    <div class="pot-col-name"><strong>${escapeHtml(p.name)}</strong></div>
                    <div class="pot-col-rank" style="color:var(--win-text-dim);">Rank ${escapeHtml(String(p.rank))}</div>
                    <div class="pot-col-rolls" style="color:#fcff61; font-family:'JetBrains Mono', monospace;">${fmtNum(p.rolls_left)} rolls</div>
                    <div class="pot-col-status"><span style="color:#03fc20; font-weight:600;">● Active</span></div>
                `;
                potContainer.appendChild(row);
            });
        }

        document.getElementById('inv-used').textContent = inventory.length;
        document.getElementById('inv-max').textContent = user.slots;
        document.getElementById('inv-expand-cost').textContent = fmtNum(expandCost);

        renderInventoryTable(inventory);
        renderOwnedPotionsTable(playerData.ownedPotions || []);
        renderOwnedHardwareTable(playerData.ownedHardware || []);

        renderProfilePane();
        renderAchievementsTable(playerData.allAchievements || []);
        renderTitlesTable(playerData.titles || []);

        renderMissionHub(missionHub);

        if (settings) {
            const savedTheme = localStorage.getItem('aris_theme') || settings.theme || 'dark';
            const themeEl = document.getElementById('set-theme');
            if (themeEl && document.activeElement !== themeEl) themeEl.value = savedTheme;

            const savedHideWm = localStorage.getItem('aris_hide_watermark') !== null
                ? localStorage.getItem('aris_hide_watermark') === '1'
                : Boolean(settings.hide_watermark);
            const hideWmEl = document.getElementById('set-hide-watermark');
            if (hideWmEl) hideWmEl.checked = savedHideWm;
            const setAutosellPos = document.getElementById('set-autosell-pos');
            if (setAutosellPos && document.activeElement !== setAutosellPos) {
                setAutosellPos.value = settings.auto_sell_threshold || '0';
            }
            const setAutosellNeg = document.getElementById('set-autosell-neg');
            if (setAutosellNeg && document.activeElement !== setAutosellNeg) {
                setAutosellNeg.value = settings.auto_sell_threshold_neg || '0';
            }
            document.getElementById('set-luck-toggle').checked = Boolean(settings.luck_toggle);
            document.getElementById('set-privacy').checked = Boolean(settings.stat_privacy);
            document.getElementById('set-bshop-ping').checked = Boolean(settings.bshop_ping);
            document.getElementById('set-hide-equip').checked = Boolean(settings.hide_equip);
            const customColorInput = document.getElementById('set-custom-color');
            const colorStatusEl = document.getElementById('set-color-status');
            if (customColorInput) {
                customColorInput.disabled = !settings.hasColorAccess;
                if (document.activeElement !== customColorInput) {
                    customColorInput.value = settings.hasColorAccess ? (settings.custom_color || '') : '';
                }
                customColorInput.placeholder = settings.hasColorAccess
                    ? '#0078D7 (Leave empty for default)'
                    : '🔒 Locked';
            }
            if (colorStatusEl) {
                colorStatusEl.textContent = settings.isColorful
                    ? '✅ Unlocked (Permanent)'
                    : '🔒 Locked';
            }
        }

        const bshopOpen = Boolean(playerData.blackMarket?.active);
        const bshopTabBtn = document.getElementById('tab-shop-bshop');
        if (bshopTabBtn) {
            bshopTabBtn.classList.toggle('hidden', !bshopOpen);
        }
        if (!bshopOpen && currentShopTab === 'bshop') {
            currentShopTab = 'potions';
            selectedShopItemId = null;
            document.querySelectorAll('[data-shop-tab]').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-shop-tab') === 'potions');
            });
        }

        renderShopList();
        if (selectedShopItemId) {
            renderShopInspector(selectedShopItemId);
        }

        const hubIcon = document.querySelector('.desktop-icon[data-target="win-hub"]');
        if (hubIcon) {
            let hubBadge = hubIcon.querySelector('.desktop-icon-badge:not(.bshop-badge)');
            const mh = playerData.missionHub || {};
            let unclaimedCount = 0;
            if (mh.canClaimDaily) unclaimedCount++;
            if (mh.canPray) unclaimedCount++;
            if (Array.isArray(mh.quests)) {
                unclaimedCount += mh.quests.filter(q => q.progress >= q.goal && !q.claimed).length;
            }
            if (unclaimedCount > 0) {
                if (!hubBadge) {
                    hubBadge = document.createElement('div');
                    hubBadge.className = 'desktop-icon-badge';
                    hubIcon.appendChild(hubBadge);
                }
                hubBadge.textContent = String(unclaimedCount);
                hubBadge.style.display = 'block';
            } else if (hubBadge) {
                hubBadge.style.display = 'none';
            }
        }

        const shopIcon = document.querySelector('.desktop-icon[data-target="win-shop"]');
        const isBshopActive = Boolean(playerData.blackMarket?.active);
        if (shopIcon) {
            let bshopBadge = shopIcon.querySelector('.desktop-icon-badge.bshop-badge');
            if (isBshopActive) {
                if (!bshopBadge) {
                    bshopBadge = document.createElement('div');
                    bshopBadge.className = 'desktop-icon-badge bshop-badge';
                    bshopBadge.textContent = 'BSHOP';
                    shopIcon.appendChild(bshopBadge);
                }
                bshopBadge.style.display = 'block';
            } else if (bshopBadge) {
                bshopBadge.style.display = 'none';
            }
        }
        if (hasCheckedInitialBshop) {
            if (isBshopActive && !lastKnownBshopActive) {
                showWinToast('🌑 The Black Market has opened for 10 minutes!', 'info', 'Black Market Spawned');
            }
        } else {
            hasCheckedInitialBshop = true;
        }
        lastKnownBshopActive = isBshopActive;
    }

    async function refreshPlayerState() {
        if (!currentUserId) return;
        const res = await apiGet(`/api/player?userId=${encodeURIComponent(currentUserId)}`);
        if (res && res.ok && res.data) {
            playerData = res.data;
            updateAllViews();
        }
    }

    async function triggerRoll(isAuto = false) {
        if (!currentUserId) return;
        const now = Date.now();
        if (now < nextRollTimestampMs) return;

        const btn = document.getElementById('btn-roll-now');
        btn.disabled = true;

        try {
            const res = await apiPost('/api/roll', { userId: currentUserId, isAuto });
            if (!res.ok) {
                if (res.error === 'PERMISSION_DENIED' || res.error === 'INSUFFICIENT_COINS') {
                    autoRollActive = false;
                    document.getElementById('btn-auto-roll').classList.remove('primary');
                    document.getElementById('roll-action-status').textContent = `❌ ${res.message}`;
                    showWinToast(res.message, 'error');
                } else if (res.cooldown) {
                    nextRollTimestampMs = Date.now() + (res.remainingMs || 1000);
                }
                return;
            }

            if (isAuto) {
                autoRollBatchCount += 1;
                if (autoRollBatchCount >= 1337) {
                    autoRollActive = false;
                    document.getElementById('btn-auto-roll').classList.remove('primary');
                    document.getElementById('roll-action-status').textContent = '⚠️ 1,337 Auto-Roll limit reached! Roll manually once to resume.';
                }
            } else {
                autoRollBatchCount = 0;
            }

            const numEl = document.getElementById('roll-main-number');
            numEl.textContent = `1 in ${res.formattedRoll}`;
            numEl.classList.toggle('negative', Boolean(res.isNegative));

            let statusText = res.actionStatus;
            if (res.logs && res.logs.length > 0) {
                statusText += ` | ${res.logs.join(' ')}`;
            }
            document.getElementById('roll-action-status').textContent = statusText;

            lastCdDurationMs = Math.max(200, (res.cooldownSeconds || 1) * 1000);
            nextRollTimestampMs = Date.now() + lastCdDurationMs;

            rollHistory.unshift({
                val: res.formattedRoll,
                status: res.actionStatus,
                time: new Date().toLocaleTimeString()
            });
            if (rollHistory.length > 25) rollHistory.pop();
            renderRollHistory();

            if (playerData && playerData.stats) {
                recordTelemetryPoint(playerData.stats, res);
            }
            await refreshPlayerState();
            if (!window.telemetryState?.paused) {
                updateTaskMgrGraph();
            }
        } finally {
            if (Date.now() >= nextRollTimestampMs) {
                btn.disabled = false;
            }
        }
    }

    function renderRollHistory() {
        const container = document.getElementById('roll-history-list');
        container.innerHTML = '';
        rollHistory.forEach(item => {
            const div = document.createElement('div');
            div.className = 'roll-history-item';
            div.innerHTML = `
                <span><strong>1 in ${item.val}</strong></span>
                <span style="color:#aaa">${item.status} • ${item.time}</span>
            `;
            container.appendChild(div);
        });
    }

    function startCooldownLoop() {
        setInterval(() => {
            const btnRoll = document.getElementById('btn-roll-now');

            const now = Date.now();
            const fillEl = document.getElementById('roll-cd-fill');
            const textEl = document.getElementById('roll-cd-text');

            if (now >= nextRollTimestampMs) {
                fillEl.style.width = '100%';
                textEl.textContent = 'Ready now';
                btnRoll.disabled = false;
                if (autoRollActive && playerData?.user?.has_auto_chip) {
                    triggerRoll(true);
                }
            } else {
                const rem = nextRollTimestampMs - now;
                const pct = Math.max(0, Math.min(100, 100 - (rem / lastCdDurationMs) * 100));
                fillEl.style.width = `${pct}%`;
                textEl.textContent = `Cooldown: ${(rem / 1000).toFixed(1)}s`;
                btnRoll.disabled = true;
            }
        }, 100);
    }

    function renderInventoryTable(inv) {
        const tbody = document.getElementById('inv-table-body');
        if (!tbody) return;
        const wrap = tbody.closest('.inv-table-wrap');
        const prevScroll = wrap ? wrap.scrollTop : 0;
        tbody.innerHTML = '';

        if (!inv || inv.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-hint">Inventory is empty. Roll numbers to store them here!</td></tr>';
            return;
        }

        inv.forEach(item => {
            const rVal = BigInt(item.roll_value || '0');
            const absVal = rVal < 0n ? -rVal : rVal;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <button class="win-btn small btn-lock-roll" data-id="${item.id}">
                        ${item.is_locked ? '🔒' : '🔓'}
                    </button>
                </td>
                <td style="color: ${rVal < 0n ? 'var(--kw-special)' : 'var(--kw-final)'}">
                    1 in ${rVal < 0n ? '-' : ''}${absVal.toLocaleString('en-US')}
                </td>
                <td>
                    <button class="win-btn small danger btn-sell-roll" data-id="${item.id}" ${item.is_locked ? 'disabled' : ''}>
                        Sell
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.btn-lock-roll').forEach(btn => {
            btn.addEventListener('click', async () => {
                const rollId = btn.getAttribute('data-id');
                await apiPost('/api/inventory/lock', { userId: currentUserId, rollId });
                await refreshPlayerState();
            });
        });

        tbody.querySelectorAll('.btn-sell-roll').forEach(btn => {
            btn.addEventListener('click', async () => {
                const rollId = btn.getAttribute('data-id');
                await apiPost('/api/inventory/sell', { userId: currentUserId, rollId });
                await refreshPlayerState();
            });
        });

        if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
    }

    function renderOwnedPotionsTable(potions) {
        const tbody = document.getElementById('inv-potions-body');
        if (!tbody) return;
        const wrap = tbody.closest('.inv-table-wrap');
        const prevScroll = wrap ? wrap.scrollTop : 0;
        tbody.innerHTML = '';

        const q = (document.getElementById('inv-pot-search')?.value || '').trim().toLowerCase();
        const filtered = (potions || []).filter(p =>
            !q ||
            (p.name || '').toLowerCase().includes(q) ||
            (p.effectText || '').toLowerCase().includes(q) ||
            String(p.rank || '').toLowerCase().includes(q)
        );

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-hint">${q ? 'No owned potions match your search.' : 'You do not own any potions yet. Buy some in the Store!'}</td></tr>`;
            return;
        }

        filtered.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.name}</strong></td>
                <td>Rank ${p.rank}</td>
                <td>x${fmtNum(p.count)}</td>
                <td>${highlightKeywords(p.effectText)}</td>
                <td>
                    <div style="display:flex; gap:4px;">
                        <button class="win-btn small primary btn-inv-use-pot" data-id="${p.id}" data-qty="1">Use 1</button>
                        <button class="win-btn small btn-inv-use-pot" data-id="${p.id}" data-qty="10">10</button>
                        <button class="win-btn small btn-inv-use-pot" data-id="${p.id}" data-qty="all">All</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.btn-inv-use-pot').forEach(btn => {
            btn.addEventListener('click', async () => {
                const itemId = btn.getAttribute('data-id');
                const qty = btn.getAttribute('data-qty');
                const res = await apiPost('/api/shop/use', { userId: currentUserId, itemId, qty });
                const cleanMsg = (res.message || '').replace(/\*\*/g, '');
                const fb = document.getElementById('inv-pot-feedback');
                if (fb) fb.textContent = cleanMsg;
                if (res.ok) {
                    showWinToast(cleanMsg || 'Potion consumed successfully!', 'info', 'Potion Consumed');
                } else {
                    showWinToast(cleanMsg || 'Could not use potion.', 'error', 'Potion Error');
                }
                await refreshPlayerState();
            });
        });

        if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
    }

    function renderOwnedHardwareTable(hwList) {
        const tbody = document.getElementById('inv-hardware-body');
        if (!tbody) return;
        const wrap = tbody.closest('.inv-table-wrap');
        const prevScroll = wrap ? wrap.scrollTop : 0;
        tbody.innerHTML = '';

        const q = (document.getElementById('inv-hw-search')?.value || '').trim().toLowerCase();
        const filtered = (hwList || []).filter(hw =>
            !q ||
            (hw.name || '').toLowerCase().includes(q) ||
            (hw.effectText || '').toLowerCase().includes(q) ||
            (hw.type || '').toLowerCase().includes(q)
        );

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-hint">${q ? 'No owned hardware matches your search.' : 'You do not own any Modules or Chips yet.'}</td></tr>`;
            return;
        }

        filtered.forEach(hw => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${hw.type === 'module' ? '⚙️ Module' : '💾 Chip'}</td>
                <td><strong>${hw.name}</strong> (x${fmtNum(hw.count)})${hw.isEquipped ? ' <span style="color:#03fc20">[Equipped]</span>' : ''}</td>
                <td>${highlightKeywords(hw.effectText)}</td>
                <td>
                    <button class="win-btn small ${hw.isEquipped ? 'danger' : 'primary'} btn-inv-equip-hw" data-id="${hw.id}" data-type="${hw.type}">
                        ${hw.isEquipped ? 'Unequip' : 'Equip'}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.btn-inv-equip-hw').forEach(btn => {
            btn.addEventListener('click', async () => {
                const itemId = btn.getAttribute('data-id');
                const type = btn.getAttribute('data-type');
                const res = await apiPost('/api/inventory/equip', { userId: currentUserId, itemId, type });
                const cleanMsg = (res.message || (res.ok ? `Updated ${type} equipment!` : 'Error')).replace(/\*\*/g, '');
                const fb = document.getElementById('inv-hw-feedback');
                if (fb) {
                    fb.textContent = cleanMsg;
                }
                if (res.ok) {
                    showWinToast(cleanMsg, 'info', 'Hardware Equipped');
                } else {
                    showWinToast(cleanMsg, 'error', 'Equip Error');
                }
                await refreshPlayerState();
            });
        });

        if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
    }

    function getTitleDisplayName(titleId) {
        const t = (playerData?.titles || []).find(x => x.id === titleId);
        if (t) return `[${t.name}]`;
        if (titleId === 'title_pixelization') return '[▣ Pixelization ▣]';
        return `[${titleId}]`;
    }

    function formatItemCost(item, isBShop = false) {
        if (!item) return '';
        if (item.craft) {
            const parts = [];
            if (item.reqCoins) parts.push(`🪙 ${fmtNum(item.reqCoins)}`);
            if (item.reqCrys) parts.push(`💎 ${fmtNum(item.reqCrys)}`);
            if (item.reqNulls) parts.push(`⬛ ${fmtNum(item.reqNulls)} NULL`);
            if (item.reqCC) parts.push(`💠 ${fmtNum(item.reqCC)} CC`);
            if (item.reqPot) parts.push(`${item.reqPotQty || 1}x ${shopCatalog.potions[item.reqPot]?.name || item.reqPot}`);
            if (item.reqPot2) parts.push(`${item.reqPot2Qty || 1}x ${shopCatalog.potions[item.reqPot2]?.name || item.reqPot2}`);
            if (item.reqMod && item.reqModOr) {
                const m1 = shopCatalog.modules[item.reqMod]?.name || item.reqMod;
                const m2 = shopCatalog.modules[item.reqModOr]?.name || item.reqModOr;
                parts.push(`1x ${m1} OR 1x ${m2}`);
            } else if (item.reqMod) {
                parts.push(`${item.reqModQty || 1}x ${shopCatalog.modules[item.reqMod]?.name || item.reqMod}`);
            }
            if (item.reqMod2) parts.push(`${item.reqMod2Qty || 1}x ${shopCatalog.modules[item.reqMod2]?.name || item.reqMod2}`);
            if (item.reqMod3) parts.push(`${item.reqMod3Qty || 1}x ${shopCatalog.modules[item.reqMod3]?.name || item.reqMod3}`);
            if (item.reqChip) parts.push(`${item.reqChipQty || 1}x ${shopCatalog.chips[item.reqChip]?.name || item.reqChip}`);
            if (item.reqChip2) parts.push(`${item.reqChip2Qty || 1}x ${shopCatalog.chips[item.reqChip2]?.name || item.reqChip2}`);
            if (item.reqTitle) parts.push(`${item.reqTitleQty || 1}x ${getTitleDisplayName(item.reqTitle)}`);
            if (item.failChance) parts.push(`⚠️ ${(item.failChance * 100).toFixed(2)}% Fail Chance`);
            return `🛠️ Craft: ${parts.join(', ')}`;
        }
        const icon = item.cur === 'crystals' ? '💎' : item.cur === 'nulls' ? '⬛' : item.cur === 'cc' ? '💠' : '🪙';
        let costVal = BigInt(item.cost || 0);
        if (isBShop && !item.noDiscount && !item.bshopOnly) {
            costVal = (costVal * 75n) / 100n;
            return `${icon} ${fmtNum(costVal)} (-25% BShop)`;
        }
        return `${icon} ${fmtNum(costVal)}`;
    }

    function calculateMaxBuyQty(id, isBShop = false) {
        if (!id || !playerData) return 1;
        const user = playerData.user || {};
        const owned = playerData.ownedItems || {};
        const daily = playerData.dailyLimits || {};

        if (id === 'item_cc') {
            const bm = playerData.blackMarket || { active: false, ccStock: 0 };
            if (!bm.active) return 1;
            const boughtCc = Number(daily['bshop_item_cc'] || 0);
            const remStock = Math.max(0, (bm.ccStock || 0) - boughtCc);
            const afford = Number(BigInt(user.crystals || '0') / 1000n);
            return Math.max(1, Math.min(remStock, afford));
        }

        const item = getCatalogItem(id);
        if (!item) return 1;

        let maxPossible = 100000;

        if (item.maxOwn) {
            const curOwned = Number(owned[id] || 0);
            maxPossible = Math.min(maxPossible, Math.max(0, item.maxOwn - curOwned));
        }

        if (!item.craft) {
            let limitVal = item.limit || 0;
            let limitKey = id;
            if (isBShop && !item.limit && !item.bshopOnly && shopCatalog.potions[id]) {
                limitVal = 100;
                limitKey = `bshop_${id}`;
            }
            if (limitVal > 0) {
                const boughtToday = Number(daily[limitKey] || 0);
                maxPossible = Math.min(maxPossible, Math.max(0, limitVal - boughtToday));
            }
        }

        if (item.craft) {
            if (item.failChance) return 1;
            if (item.reqCoins) {
                maxPossible = Math.min(maxPossible, Number(BigInt(user.coins || '0') / BigInt(item.reqCoins)));
            }
            if (item.reqCrys) {
                maxPossible = Math.min(maxPossible, Number(BigInt(user.crystals || '0') / BigInt(item.reqCrys)));
            }
            if (item.reqNulls) {
                maxPossible = Math.min(maxPossible, Number(BigInt(user.nulls || '0') / BigInt(item.reqNulls)));
            }
            if (item.reqCC) {
                maxPossible = Math.min(maxPossible, Number(BigInt(user.cc_coins || '0') / BigInt(item.reqCC)));
            }
            if (item.reqPot) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqPot] || 0) / (item.reqPotQty || 1)));
            }
            if (item.reqPot2) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqPot2] || 0) / (item.reqPot2Qty || 1)));
            }
            if (item.reqMod && item.reqModOr) {
                const totalOr = Number(owned[item.reqMod] || 0) + Number(owned[item.reqModOr] || 0);
                maxPossible = Math.min(maxPossible, totalOr);
            } else if (item.reqMod) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqMod] || 0) / (item.reqModQty || 1)));
            }
            if (item.reqMod2) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqMod2] || 0) / (item.reqMod2Qty || 1)));
            }
            if (item.reqMod3) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqMod3] || 0) / (item.reqMod3Qty || 1)));
            }
            if (item.reqChip) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqChip] || 0) / (item.reqChipQty || 1)));
            }
            if (item.reqChip2) {
                maxPossible = Math.min(maxPossible, Math.floor(Number(owned[item.reqChip2] || 0) / (item.reqChip2Qty || 1)));
            }
            if (item.reqTitle) {
                const tObj = (playerData.titles || []).find(t => t.id === item.reqTitle);
                const tCount = tObj ? Number(tObj.count || 0) : 0;
                maxPossible = Math.min(maxPossible, Math.floor(tCount / (item.reqTitleQty || 1)));
            }
        } else {
            let unitCost = BigInt(item.cost || 0);
            if (isBShop && !item.noDiscount && !item.bshopOnly) {
                unitCost = (unitCost * 75n) / 100n;
            }
            if (unitCost > 0n) {
                const balStr = item.cur === 'crystals'
                    ? user.crystals
                    : item.cur === 'nulls'
                        ? user.nulls
                        : item.cur === 'cc'
                            ? user.cc_coins
                            : user.coins;
                const afford = Number(BigInt(balStr || '0') / unitCost);
                maxPossible = Math.min(maxPossible, afford);
            }
        }

        return Math.max(1, maxPossible);
    }

    function getCatalogItem(id) {
        if (id === 'item_cc') {
            return {
                id: 'item_cc',
                name: 'Compressed Crystal (CC)',
                cur: 'crystals',
                cost: '1000',
                bshopOnly: true,
                noDiscount: true,
                effectText: 'Primary endgame currency in Black Market and high-tier Module crafting.',
                lore: '[Condensed crystalline energy.]'
            };
        }
        return shopCatalog.potions[id] || shopCatalog.modules[id] || shopCatalog.chips[id] || null;
    }

    function renderShopList() {
        const listEl = document.getElementById('shop-items-list');
        const standardView = document.getElementById('shop-standard-view');
        if (standardView) standardView.classList.remove('hidden');

        const prevScroll = listEl.scrollTop;
        listEl.innerHTML = '';
        const q = (document.getElementById('shop-search-input')?.value || '').trim().toLowerCase();

        if (currentShopTab === 'bshop') {
            const bm = playerData?.blackMarket || { active: false, items: [], ccStock: 0 };
            const statusBanner = document.createElement('div');
            statusBanner.style.padding = '8px 10px';
            statusBanner.style.borderBottom = '1px solid var(--win-border)';
            statusBanner.style.background = bm.active ? 'rgba(3, 252, 32, 0.1)' : 'rgba(232, 17, 35, 0.15)';
            const remMin = bm.active ? Math.max(1, Math.ceil((bm.expiresAt - Date.now()) / 60000)) : 0;
            statusBanner.innerHTML = bm.active
                ? `🟢 <strong>Black Market OPEN!</strong> (${remMin}m left • CC Stock: ${bm.ccStock})`
                : `🔴 <strong>Black Market Closed</strong>`;
            listEl.appendChild(statusBanner);

            const bshopEntries = [['item_cc', getCatalogItem('item_cc')]];
            for (const [id, item] of Object.entries(shopCatalog.potions || {})) {
                if (!item.unbuyable) bshopEntries.push([id, item]);
            }

            bshopEntries.forEach(([id, item]) => {
                if (q && !(item.name || id).toLowerCase().includes(q) && !(item.effectText || '').toLowerCase().includes(q)) return;
                const inStock = bm.active && (!item.bshopOnly || bm.items.includes(id));
                const row = document.createElement('div');
                row.className = 'shop-item-row' + (selectedShopItemId === id ? ' selected' : '');
                row.dataset.itemId = id;
                row.innerHTML = `
                    <span class="shop-item-name">${item.bshopOnly ? '🌑 ' : ''}${item.name || id}</span>
                    <span class="shop-item-cost">${formatItemCost(item, true)} ${item.bshopOnly && bm.active ? (inStock ? '✅' : '❌ Out') : ''}</span>
                `;
                row.addEventListener('click', () => {
                    selectedShopItemId = id;
                    renderShopList();
                    renderShopInspector(id);
                });
                listEl.appendChild(row);
            });
            if (prevScroll > 0) listEl.scrollTop = prevScroll;
            return;
        }

        const group = shopCatalog[currentShopTab] || {};
        Object.entries(group).forEach(([id, item]) => {
            if (item.unbuyable || item.bshopOnly) return;
            if (q && !(item.name || id).toLowerCase().includes(q) && !(item.effectText || '').toLowerCase().includes(q)) return;
            const row = document.createElement('div');
            row.className = 'shop-item-row' + (selectedShopItemId === id ? ' selected' : '');
            row.dataset.itemId = id;
            row.innerHTML = `
                <span class="shop-item-name">${item.name || id}</span>
                <span class="shop-item-cost">${formatItemCost(item, false)}</span>
            `;
            row.addEventListener('click', () => {
                selectedShopItemId = id;
                renderShopList();
                renderShopInspector(id);
            });
            listEl.appendChild(row);
        });
        if (prevScroll > 0) listEl.scrollTop = prevScroll;
    }

    function renderCraftChecklist(item, rawQty) {
        const checklistEl = document.getElementById('insp-craft-checklist');
        if (!checklistEl) return;
        if (!item || !item.craft || !playerData) {
            checklistEl.innerHTML = '';
            checklistEl.classList.add('hidden');
            return;
        }

        const user = playerData.user || {};
        const owned = playerData.ownedItems || {};
        const titles = playerData.titles || [];
        const mult = BigInt(Math.max(1, parseInt(rawQty, 10) || 1));

        const reqs = [];

        if (item.reqCoins) {
            const need = BigInt(item.reqCoins) * mult;
            const have = BigInt(user.coins || '0');
            reqs.push({ name: 'Coins', have, need, unit: '🪙' });
        }
        if (item.reqCrys) {
            const need = BigInt(item.reqCrys) * mult;
            const have = BigInt(user.crystals || '0');
            reqs.push({ name: 'Crystals', have, need, unit: '💎' });
        }
        if (item.reqNulls) {
            const need = BigInt(item.reqNulls) * mult;
            const have = BigInt(user.nulls || '0');
            reqs.push({ name: 'NULL', have, need, unit: '⬛' });
        }
        if (item.reqCC) {
            const need = BigInt(item.reqCC) * mult;
            const have = BigInt(user.cc_coins || 0);
            reqs.push({ name: 'CC (Compressed Crystal)', have, need, unit: '💠' });
        }
        if (item.reqPot) {
            const potName = shopCatalog.potions[item.reqPot]?.name || item.reqPot;
            const need = BigInt(item.reqPotQty || 1) * mult;
            const have = BigInt(owned[item.reqPot] || 0);
            reqs.push({ name: potName, have, need, unit: '🧪' });
        }
        if (item.reqPot2) {
            const potName = shopCatalog.potions[item.reqPot2]?.name || item.reqPot2;
            const need = BigInt(item.reqPot2Qty || 1) * mult;
            const have = BigInt(owned[item.reqPot2] || 0);
            reqs.push({ name: potName, have, need, unit: '🧪' });
        }
        if (item.reqMod && item.reqModOr) {
            const m1 = shopCatalog.modules[item.reqMod]?.name || item.reqMod;
            const m2 = shopCatalog.modules[item.reqModOr]?.name || item.reqModOr;
            const need = 1n * mult;
            const have = BigInt(owned[item.reqMod] || 0) + BigInt(owned[item.reqModOr] || 0);
            reqs.push({ name: `${m1} OR ${m2}`, have, need, unit: '⚙️' });
        } else if (item.reqMod) {
            const modName = shopCatalog.modules[item.reqMod]?.name || item.reqMod;
            const need = BigInt(item.reqModQty || 1) * mult;
            const have = BigInt(owned[item.reqMod] || 0);
            reqs.push({ name: modName, have, need, unit: '⚙️' });
        }
        if (item.reqMod2) {
            const modName = shopCatalog.modules[item.reqMod2]?.name || item.reqMod2;
            const need = BigInt(item.reqMod2Qty || 1) * mult;
            const have = BigInt(owned[item.reqMod2] || 0);
            reqs.push({ name: modName, have, need, unit: '⚙️' });
        }
        if (item.reqMod3) {
            const modName = shopCatalog.modules[item.reqMod3]?.name || item.reqMod3;
            const need = BigInt(item.reqMod3Qty || 1) * mult;
            const have = BigInt(owned[item.reqMod3] || 0);
            reqs.push({ name: modName, have, need, unit: '⚙️' });
        }
        if (item.reqChip) {
            const chipName = shopCatalog.chips[item.reqChip]?.name || item.reqChip;
            const need = BigInt(item.reqChipQty || 1) * mult;
            const have = BigInt(owned[item.reqChip] || 0);
            reqs.push({ name: chipName, have, need, unit: '💾' });
        }
        if (item.reqChip2) {
            const chipName = shopCatalog.chips[item.reqChip2]?.name || item.reqChip2;
            const need = BigInt(item.reqChip2Qty || 1) * mult;
            const have = BigInt(owned[item.reqChip2] || 0);
            reqs.push({ name: chipName, have, need, unit: '💾' });
        }
        if (item.reqTitle) {
            const titleName = getTitleDisplayName(item.reqTitle);
            const tObj = titles.find(t => t.id === item.reqTitle);
            const have = BigInt(tObj ? (tObj.count || 0) : 0);
            const need = BigInt(item.reqTitleQty || 1) * mult;
            reqs.push({ name: `Title: ${titleName}`, have, need, unit: '👑' });
        }

        if (reqs.length === 0) {
            checklistEl.innerHTML = '';
            checklistEl.classList.add('hidden');
            return;
        }

        checklistEl.classList.remove('hidden');
        checklistEl.innerHTML = `
            <div class="craft-checklist-header">Crafting Materials Checklist (${fmtNum(mult)}x)</div>
            ${reqs.map(r => {
                const met = r.have >= r.need;
                const statusIcon = met ? '✅' : '❌';
                const statusClass = met ? 'req-met' : 'req-unmet';
                const statusColor = met ? '#03fc20' : '#ff4d4d';
                return `<div class="craft-req-pill ${statusClass}" style="color: ${statusColor};">${statusIcon} [${fmtNum(r.have)} / ${fmtNum(r.need)}] ${r.unit} ${r.name}</div>`;
            }).join('')}
        `;
    }

    function renderShopInspector(id) {
        const item = getCatalogItem(id);
        if (!item) return;

        const isBShop = currentShopTab === 'bshop';
        const ownedQty = id === 'item_cc'
            ? (playerData?.user?.cc_coins || 0)
            : (playerData?.ownedItems?.[id] || 0);
        const isEquipped = playerData?.user?.equipped_module === id || playerData?.user?.equipped_chip === id;

        document.getElementById('insp-name').textContent = item.name || id;
        const limitTag = item.limit ? ` • Daily Limit: ${item.limit}` : '';
        document.getElementById('insp-cost').textContent =
            formatItemCost(item, isBShop) + (item.rank !== undefined ? ` • Rank ${item.rank}` : '') + limitTag;
        document.getElementById('insp-owned').textContent =
            `Owned: ${fmtNum(ownedQty)}` + (isEquipped ? ' (EQUIPPED)' : '');

        document.getElementById('insp-effect').innerHTML = highlightKeywords(item.effectText || 'No effect description.');
        document.getElementById('insp-lore').textContent = item.lore || '';

        const rawQty = document.getElementById('shop-qty-input')?.value || '1';
        renderCraftChecklist(item, rawQty);

        const buyBtn = document.getElementById('btn-shop-buy');
        const useBtn = document.getElementById('btn-shop-use');

        buyBtn.disabled = false;
        buyBtn.textContent = isBShop
            ? (item.craft ? 'Craft (BShop)' : 'Buy (Black Market)')
            : (item.craft ? 'Craft Item' : 'Buy Item');

        if (id === 'item_cc') {
            useBtn.disabled = true;
            useBtn.textContent = 'Currency';
        } else if (shopCatalog.potions[id]) {
            useBtn.disabled = ownedQty < 1;
            useBtn.textContent = 'Use Potion';
        } else {
            useBtn.disabled = ownedQty < 1;
            useBtn.textContent = isEquipped ? 'Unequip' : 'Equip';
        }
    }

    function renderProfilePane() {
        const container = document.getElementById('profile-stat-content');
        if (!container || !playerData) return;

        const p = inspectedProfileOverride || {
            id: playerData.user.id,
            username: playerData.user.username,
            coins: playerData.user.coins,
            crystals: playerData.user.crystals,
            nulls: playerData.user.nulls,
            cc_coins: playerData.user.cc_coins,
            total_rolls: playerData.user.total_rolls,
            total_score: playerData.user.total_score,
            highest_pos: playerData.user.highest_pos,
            lowest_neg: playerData.user.lowest_neg,
            equipped_module: shopCatalog.modules[playerData.user.equipped_module]?.name || 'None',
            equipped_chip: shopCatalog.chips[playerData.user.equipped_chip]?.name || 'None',
            equipped_title: (playerData.titles || []).find(t => t.id === playerData.user.equipped_title)?.name || 'None',
            equipped_achieve: (playerData.allAchievements || []).find(a => a.id === playerData.user.equipped_achieve)?.name || 'None'
        };

        container.innerHTML = `
            <div class="stat-info-box">
                <h4>👤 Identity &amp; Status</h4>
                <div><strong>Player:</strong> ${p.username}</div>
                <div><strong>Discord ID:</strong> <span class="mono">${p.id}</span></div>
                <div><strong>Equipped Title:</strong> <span class="kw-final">[${p.equipped_title}]</span></div>
                <div><strong>Equipped Achievement:</strong> 🏆 ${p.equipped_achieve}</div>
            </div>
            <div class="stat-info-box">
                <h4>💰 Treasury Balances</h4>
                <div>🪙 Coins: <strong class="mono">${fmtNum(p.coins)}</strong></div>
                <div>💎 Crystals: <strong class="mono">${fmtNum(p.crystals)}</strong></div>
                <div>⬛ NULL: <strong class="mono">${fmtNum(p.nulls)}</strong></div>
                <div>💠 CC: <strong class="mono">${fmtNum(p.cc_coins)}</strong></div>
            </div>
            <div class="stat-info-box">
                <h4>🎲 Simulation Records</h4>
                <div>Total Rolls: <strong class="mono">${fmtNum(p.total_rolls)}</strong></div>
                <div>Total Score: <strong class="mono">${fmtNum(p.total_score)}</strong></div>
                <div>Best Roll (+): <strong class="mono kw-final">1 in ${fmtNum(p.highest_pos)}</strong></div>
                <div>Best Roll (-): <strong class="mono kw-special">${p.lowest_neg && p.lowest_neg !== '0' ? '1 in ' + fmtNum(p.lowest_neg) : 'None'}</strong></div>
            </div>
            <div class="stat-info-box">
                <h4>⚙️ Equipped Hardware</h4>
                <div>⚙️ Primary Module: <strong>${p.equipped_module}</strong></div>
                <div>💾 Secondary Chip: <strong>${p.equipped_chip}</strong></div>
            </div>
        `;
    }

    function renderAchievementsTable(allAch) {
        const tbody = document.getElementById('ach-table-body');
        const countEl = document.getElementById('ach-unlocked-count');
        if (!tbody) return;
        const wrap = tbody.closest('.inv-table-wrap');
        const prevScroll = wrap ? wrap.scrollTop : 0;

        const unlockedCount = allAch.filter(a => a.unlocked).length;
        if (countEl) countEl.textContent = `${unlockedCount} / ${allAch.length}`;

        const q = (document.getElementById('ach-search-input')?.value || '').trim().toLowerCase();
        const filtered = (allAch || []).filter(a =>
            !q ||
            (a.name || '').toLowerCase().includes(q) ||
            (a.req || '').toLowerCase().includes(q) ||
            (a.rewardText || '').toLowerCase().includes(q)
        );

        tbody.innerHTML = '';
        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-hint">No achievements match your search.</td></tr>';
            if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
            return;
        }

        filtered.forEach(a => {
            const descCell = a.rewardText
                ? `<span style="color:var(--kw-final)">${a.rewardText}</span>`
                : '<span style="color:#777">—</span>';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong style="color:${a.unlocked ? 'var(--kw-basic)' : '#888'}">${a.unlocked ? '🏆 ' : '🔒 '}${a.name}</strong></td>
                <td>${a.req || '???'}</td>
                <td style="font-style:italic; color:var(--win-text-dim)">${descCell}</td>
                <td>
                    ${a.unlocked ? `
                        <button class="win-btn small ${a.isEquipped ? 'danger' : 'primary'} btn-equip-ach" data-id="${a.id}">
                            ${a.isEquipped ? 'Unequip' : 'Equip'}
                        </button>
                    ` : '<span style="color:#777">—</span>'}
                </td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.btn-equip-ach').forEach(btn => {
            btn.addEventListener('click', async () => {
                const achId = btn.getAttribute('data-id');
                const res = await apiPost('/api/achieve/equip', { userId: currentUserId, achId });
                const fb = document.getElementById('ach-feedback');
                if (fb) fb.textContent = res.message || '';
                await refreshPlayerState();
            });
        });

        if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
    }

    function renderTitlesTable(titles) {
        const tbody = document.getElementById('title-table-body');
        if (!tbody) return;
        const wrap = tbody.closest('.inv-table-wrap');
        const prevScroll = wrap ? wrap.scrollTop : 0;
        tbody.innerHTML = '';

        const q = (document.getElementById('title-search-input')?.value || '').trim().toLowerCase();
        const filtered = (titles || []).filter(t =>
            !q || (t.name || '').toLowerCase().includes(q)
        );

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-hint">No titles match your search.</td></tr>';
            if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
            return;
        }

        filtered.forEach(t => {
            const rarityVal = Number(t.rarity !== undefined ? t.rarity : t.chance) || 0;
            const rarityDisplay = rarityVal > 0 ? `1 in ${fmtNum(rarityVal)}` : 'Cannot be rolled';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong style="color:${t.unlocked ? (t.customColor || 'var(--kw-final)') : '#888'}">[${t.name}]</strong></td>
                <td>${rarityDisplay}</td>
                <td>x${fmtNum(t.count)}</td>
                <td>
                    ${t.unlocked ? `
                        <button class="win-btn small ${t.isEquipped ? 'danger' : 'primary'} btn-equip-title" data-id="${t.id}">
                            ${t.isEquipped ? 'Unequip' : 'Equip'}
                        </button>
                    ` : '<span style="color:#777">—</span>'}
                </td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.btn-equip-title').forEach(btn => {
            btn.addEventListener('click', async () => {
                const titleId = btn.getAttribute('data-id');
                const res = await apiPost('/api/title/equip', { userId: currentUserId, titleId });
                const fb = document.getElementById('title-feedback');
                if (fb) fb.textContent = res.message || '';
                await refreshPlayerState();
            });
        });

        if (wrap && prevScroll > 0) wrap.scrollTop = prevScroll;
    }

    function renderMissionHub(hub) {
        if (!hub) return;

        const dailyStatus = document.getElementById('daily-status-text');
        const dailyBtn = document.getElementById('btn-claim-daily');
        if (hub.canClaimDaily) {
            dailyStatus.textContent = '🟢 Daily Supply Drop is READY to claim!';
            dailyBtn.disabled = false;
        } else {
            const remSec = Math.max(1, Math.ceil((hub.nextResetUnix * 1000 - Date.now()) / 1000));
            dailyStatus.textContent = `⏳ Already claimed today. Next reset at 00:00 UTC (in ${fmtDurationSec(remSec)})`;
            dailyBtn.disabled = true;
        }

        const permLuckEl = document.getElementById('pray-perm-luck');
        if (permLuckEl) permLuckEl.textContent = `+${Number(hub.permBasicLuck || 0).toFixed(2)}`;
        document.getElementById('pray-streak-val').textContent = fmtNum(hub.prayCount || hub.prayStreak || 0);
        const eonEl = document.getElementById('pray-eon-streak');
        if (eonEl) eonEl.textContent = `${hub.eonStreak || 0} / 54`;

        const prayStatus = document.getElementById('pray-status-text');
        const prayBtn = document.getElementById('btn-pray-now');
        const prayRemSec = Math.ceil((hub.nextPrayUnix * 1000 - Date.now()) / 1000);
        if (prayRemSec <= 0) {
            prayStatus.textContent = '🟢 Shrine is ready for your prayer! (+0.01 Permanent Basic Luck)';
            prayBtn.disabled = false;
        } else {
            prayStatus.textContent = `⏳ Shrine 6h Cooldown: ${fmtDurationSec(prayRemSec)} remaining`;
            prayBtn.disabled = false;
        }

        document.getElementById('quest-token-count').textContent = fmtNum(hub.questTokens);
        document.getElementById('quest-reroll-count').textContent = fmtNum(hub.rerollsLeft);

        const qContainer = document.getElementById('quest-list-container');
        qContainer.innerHTML = '';
        (hub.quests || []).forEach(q => {
            const isDone = q.progress >= q.goal;
            const card = document.createElement('div');
            card.className = 'quest-card';
            card.innerHTML = `
                <div>
                    <strong>${q.desc}</strong>
                    <div class="mono" style="font-size:11px; color:var(--win-text-dim)">
                        Progress: ${fmtNum(q.progress)} / ${fmtNum(q.goal)} ${q.claimed ? '• ✅ CLAIMED' : (isDone ? '• 🌟 READY TO CLAIM' : '')}
                    </div>
                </div>
                <div style="display:flex; gap:6px;">
                    <button class="win-btn small primary btn-quest-claim" data-idx="${q.index}" ${(!isDone || q.claimed) ? 'disabled' : ''}>
                        ${q.claimed ? 'Claimed' : 'Claim'}
                    </button>
                    <button class="win-btn small btn-quest-reroll" data-idx="${q.index}" ${q.claimed ? 'disabled' : ''}>
                        🔄 Reroll
                    </button>
                </div>
            `;
            qContainer.appendChild(card);
        });

        qContainer.querySelectorAll('.btn-quest-claim').forEach(btn => {
            btn.addEventListener('click', async () => {
                const questIndex = Number(btn.getAttribute('data-idx'));
                const res = await apiPost('/api/quest/claim', { userId: currentUserId, questIndex });
                document.getElementById('quest-feedback').textContent = res.message || '';
                await refreshPlayerState();
            });
        });

        qContainer.querySelectorAll('.btn-quest-reroll').forEach(btn => {
            btn.addEventListener('click', async () => {
                const questIndex = Number(btn.getAttribute('data-idx'));
                const res = await apiPost('/api/quest/reroll', { userId: currentUserId, questIndex });
                document.getElementById('quest-feedback').textContent = res.message || '';
                await refreshPlayerState();
            });
        });
    }

    async function loadLeaderboard() {
        const tbody = document.getElementById('lb-table-body');
        const btnPrev = document.getElementById('btn-lb-prev');
        const btnNext = document.getElementById('btn-lb-next');
        if (!tbody) return;
        document.getElementById('lb-page-label').textContent = `Page ${lbState.page}`;

        const res = await apiGet(`/api/leaderboard?type=${encodeURIComponent(lbState.type)}&period=${encodeURIComponent(lbState.period)}&page=${lbState.page}`);
        if (res && res.nextRefreshUnix) {
            lbNextRefreshUnix = res.nextRefreshUnix;
        } else if (!lbNextRefreshUnix) {
            lbNextRefreshUnix = Math.floor(Date.now() / 1000) + 300;
        }

        if (btnPrev) btnPrev.disabled = (lbState.page <= 1);
        if (btnNext) btnNext.disabled = !res || !res.hasMore;

        tbody.innerHTML = '';

        if (!res.ok || !res.entries || res.entries.length === 0) {
            if (lbState.page > 1) {
                lbState.page = Math.max(1, lbState.page - 1);
                return loadLeaderboard();
            }
            tbody.innerHTML = '<tr><td colspan="4" class="empty-hint">No records found for this category/period.</td></tr>';
            if (btnNext) btnNext.disabled = true;
            return;
        }

        res.entries.forEach(e => {
            const tr = document.createElement('tr');
            const badges = [];
            if (e.titleName) badges.push(`[${e.titleName}]`);
            if (e.achName) badges.push(`🏆 ${e.achName}`);
            tr.innerHTML = `
                <td><strong>#${e.rank}</strong></td>
                <td>${e.displayName}</td>
                <td style="color:var(--win-text-dim)">${badges.join(' • ') || '—'}</td>
                <td class="kw-final">${e.formattedVal}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    let pendingTerminalPrompt = null;

    function triggerSystemShutdown() {
        apiPost('/api/auth/logout', {}).catch(() => {});
        sessionToken = '';
        authUserId = null;
        currentUserId = null;
        autoRollActive = false;
        localStorage.removeItem('aris_session_token');

        try {
            window.open('', '_self', '');
            window.close();
        } catch (e) {}

        setTimeout(() => {
            try { window.close(); } catch (e) {}
            try { window.location.replace('about:blank'); } catch (e) {}
        }, 50);
    }

    async function runTerminalCommand(cmdText) {
        const clean = (cmdText || '').trim();
        if (!clean) return;

        const outEl = document.getElementById('terminal-output');
        const lineIn = document.createElement('div');
        lineIn.style.color = '#03fc20';
        lineIn.textContent = `C:\\ARIS> ${clean}`;
        outEl.appendChild(lineIn);

        if (pendingTerminalPrompt) {
            const lower = clean.toLowerCase();
            if (lower === 'y' || lower === 'yes') {
                const action = pendingTerminalPrompt.type;
                pendingTerminalPrompt = null;
                if (action === 'logout') {
                    const lineOut = document.createElement('div');
                    lineOut.style.color = '#ffcc00';
                    lineOut.textContent = 'Logging out of A.R.I.S OS... Goodbye!';
                    outEl.appendChild(lineOut);
                    outEl.appendChild(document.createElement('br'));
                    outEl.scrollTop = outEl.scrollHeight;
                    setTimeout(() => { handleLogout(); }, 600);
                    return;
                } else if (action === 'shutdown') {
                    const lineOut = document.createElement('div');
                    lineOut.style.color = '#ff4444';
                    lineOut.textContent = '🛑 Closing A.R.I.S OS and shutting down tab...';
                    outEl.appendChild(lineOut);
                    outEl.appendChild(document.createElement('br'));
                    outEl.scrollTop = outEl.scrollHeight;
                    setTimeout(() => { triggerSystemShutdown(); }, 200);
                    return;
                }
            } else if (lower === 'n' || lower === 'no') {
                const action = pendingTerminalPrompt.type;
                pendingTerminalPrompt = null;
                const lineOut = document.createElement('div');
                lineOut.style.color = '#66b8ff';
                lineOut.textContent = `Operation [${action}] cancelled.`;
                outEl.appendChild(lineOut);
                outEl.appendChild(document.createElement('br'));
                outEl.scrollTop = outEl.scrollHeight;
                return;
            } else {
                const lineOut = document.createElement('div');
                lineOut.style.color = '#ff6666';
                lineOut.textContent = 'Invalid input. Are you sure? Please enter [Y]es or [N]o:';
                outEl.appendChild(lineOut);
                outEl.scrollTop = outEl.scrollHeight;
                return;
            }
        }

        const lowerCmd = clean.toLowerCase();

        if (lowerCmd === 'logout') {
            pendingTerminalPrompt = { type: 'logout' };
            const lineOut = document.createElement('div');
            lineOut.style.color = '#ffcc00';
            lineOut.textContent = '⚠️ Are you sure you want to log out of A.R.I.S Web OS? (Y/N)';
            outEl.appendChild(lineOut);
            outEl.appendChild(document.createElement('br'));
            outEl.scrollTop = outEl.scrollHeight;
            return;
        }

        if (lowerCmd === 'shutdown') {
            pendingTerminalPrompt = { type: 'shutdown' };
            const lineOut = document.createElement('div');
            lineOut.style.color = '#ff4444';
            lineOut.textContent = '🛑 Are you sure you want to shut down A.R.I.S OS? (Y/N)';
            outEl.appendChild(lineOut);
            outEl.appendChild(document.createElement('br'));
            outEl.scrollTop = outEl.scrollHeight;
            return;
        }

        const res = await apiPost('/api/terminal', { userId: currentUserId, command: clean });
        if (res.ok) {
            if (res.output === '__CLEAR__') {
                outEl.innerHTML = '';
            } else {
                const lineOut = document.createElement('div');
                lineOut.textContent = res.output;
                outEl.appendChild(lineOut);
                outEl.appendChild(document.createElement('br'));
            }
            outEl.scrollTop = outEl.scrollHeight;

            if (res.openWindow) {
                openWindow(res.openWindow, res.openTab || null);
            }

            await refreshPlayerState();
        }
    }

    function unmountDynamicDevGui() {
        const winEl = document.getElementById('win-dev-control');
        if (winEl) winEl.remove();
        const iconEl = document.getElementById('desktop-icon-dev');
        if (iconEl) iconEl.remove();
        const startEl = document.getElementById('start-item-dev');
        if (startEl) startEl.remove();
        openWindows.delete('win-dev-control');
        renderTaskbar();
    }

    async function mountDynamicDevGui() {
        if (!isDevAccount) {
            unmountDynamicDevGui();
            return;
        }

        const overviewRes = await apiGet('/api/dev/overview');
        if (!overviewRes || !overviewRes.ok) {
            unmountDynamicDevGui();
            return;
        }

        if (!document.getElementById('desktop-icon-dev')) {
            const iconsContainer = document.getElementById('desktop-icons-container');
            if (iconsContainer) {
                const iconDiv = document.createElement('div');
                iconDiv.className = 'desktop-icon';
                iconDiv.id = 'desktop-icon-dev';
                iconDiv.setAttribute('data-target', 'win-dev-control');
                iconDiv.innerHTML = `
                    <div class="icon-glyph">🛠️</div>
                    <div class="icon-label">Dev Control</div>
                `;
                iconsContainer.appendChild(iconDiv);
                bindDesktopIconEvents(iconDiv);
            }
        }

        if (!document.getElementById('start-item-dev')) {
            const startList = document.getElementById('start-app-list');
            if (startList) {
                const startItem = document.createElement('div');
                startItem.className = 'start-item';
                startItem.id = 'start-item-dev';
                startItem.setAttribute('data-open', 'win-dev-control');
                startItem.innerHTML = '<span>🛠️</span> Dev Control (&gt;control)';
                startItem.addEventListener('click', () => {
                    document.getElementById('start-menu').classList.add('hidden');
                    openWindow('win-dev-control');
                });
                startList.appendChild(startItem);
            }
        }

        if (!document.getElementById('win-dev-control')) {
            const desktop = document.getElementById('desktop');
            const winDiv = document.createElement('div');
            winDiv.className = 'window hidden';
            winDiv.id = 'win-dev-control';
            winDiv.setAttribute('data-title', 'Dev Control');
            winDiv.setAttribute('data-icon', '🛠️');
            winDiv.style.cssText = 'top: 55px; left: 210px; width: 720px; height: 520px;';
            winDiv.innerHTML = `
                <div class="title-bar">
                    <div class="title-bar-left">
                        <span class="win-icon">🛠️</span>
                        <span class="win-title">Developer Control Center (&gt;control &amp; Switch User)</span>
                    </div>
                    <div class="title-bar-controls">
                        <button class="win-ctrl btn-min" title="Minimize">&#x2012;</button>
                        <button class="win-ctrl btn-max" title="Maximize">&#x25A1;</button>
                        <button class="win-ctrl btn-close" title="Close">&#x2715;</button>
                    </div>
                </div>
                <div class="window-body">
                    <div class="win-tabs">
                        <button class="win-tab active" data-dev-tab="users">🕵️ Switch User &amp; Inspector</button>
                        <button class="win-tab" data-dev-tab="economy">💰 Currency, Luck &amp; Items</button>
                        <button class="win-tab" data-dev-tab="events">🌍 Codes &amp; Global Events</button>
                    </div>
                    <div id="dev-control-feedback" class="shop-feedback"></div>

                    <!-- Tab 1: Switch User -->
                    <div class="prof-pane" id="dev-pane-users">
                        <div class="inv-toolbar" style="margin-bottom:8px;">
                            <span>🔒 <strong>Developer Authority Verified:</strong> Click any account to inspect or test live state.</span>
                            <button class="win-btn small primary" id="btn-return-own-user">Return to My Account</button>
                        </div>
                        <input type="text" id="dev-user-filter" class="win-input dev-search-filter" placeholder="🔍 Filter users by username or ID..." />
                        <div class="users-list" id="users-list"></div>
                    </div>

                    <!-- Tab 2: Economy, Luck & Items -->
                    <div class="prof-pane hidden" id="dev-pane-economy">
                        <div class="inv-toolbar">
                            <label>Target User ID:</label>
                            <input type="text" id="dev-target-uid" class="win-input" value="${currentUserId || ''}" />
                        </div>
                        <div class="dev-control-grid">
                            <div class="dev-card">
                                <h4>💰 Currency &amp; Permanent Luck</h4>
                                <select id="dev-curr-field" class="win-input full-w">
                                    <option value="coins">🪙 Coins</option>
                                    <option value="crystals">💎 Crystals</option>
                                    <option value="nulls">⬛ NULL</option>
                                    <option value="cc">💠 Compressed Crystal (CC)</option>
                                    <option value="perm_basic">🍀 Permanent Basic Luck</option>
                                    <option value="perm_multi">⚡ Permanent Multi Luck</option>
                                    <option value="perm_special">✨ Permanent Special Luck</option>
                                    <option value="perm_final">🌟 Permanent FINAL LUCK</option>
                                </select>
                                <div class="pshop-form-row">
                                    <select id="dev-curr-op" class="win-input small">
                                        <option value="add">Add</option>
                                        <option value="remove">Remove</option>
                                        <option value="set">Set</option>
                                    </select>
                                    <input type="text" id="dev-curr-amount" class="win-input" placeholder="Amount (e.g. 50000)" value="1000" />
                                </div>
                                <div class="dev-presets-row">
                                    <button type="button" class="dev-preset-btn" data-preset="10000" data-op="add">+10K</button>
                                    <button type="button" class="dev-preset-btn" data-preset="1000000" data-op="add">+1M</button>
                                    <button type="button" class="dev-preset-btn" data-preset="100000000" data-op="add">+100M</button>
                                    <button type="button" class="dev-preset-btn" data-preset="1000000000" data-op="add">+1B</button>
                                    <button type="button" class="dev-preset-btn" data-preset="10000000000" data-op="add">+10B</button>
                                    <button type="button" class="dev-preset-btn" data-preset="0" data-op="set">Set 0</button>
                                    <button type="button" class="dev-preset-btn" data-preset="999999999999" data-op="set">Max</button>
                                </div>
                                <button class="win-btn primary full-w" id="btn-dev-exec-curr">Apply Currency / Luck</button>
                            </div>

                            <div class="dev-card">
                                <h4>🎒 Grant Item / Title / Achievement / Effect</h4>
                                <select id="dev-grant-picker" class="win-input full-w" style="margin-bottom:6px;">
                                    <option value="">✨ Quick Pick: Select Potion, Module, Chip, Title...</option>
                                </select>
                                <select id="dev-grant-type" class="win-input full-w">
                                    <option value="give_item">🧪 Grant Item (Potion/Module/Chip ID)</option>
                                    <option value="give_title">👑 Grant Title ID</option>
                                    <option value="give_achieve">🏆 Unlock Achievement ID</option>
                                    <option value="give_effect">⚡ Grant Active Potion Effect (Rolls)</option>
                                </select>
                                <div class="pshop-form-row">
                                    <input type="text" id="dev-grant-id" class="win-input" placeholder="ID (e.g. heavenly_pot, developer)" />
                                    <input type="number" id="dev-grant-qty" class="win-input small" value="1" />
                                </div>
                                <div class="pshop-btn-pair">
                                    <button class="win-btn primary" id="btn-dev-exec-grant">Execute Grant</button>
                                    <button class="win-btn danger" id="btn-dev-reset-user">Reset Target User</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Tab 3: Codes & Global Events -->
                    <div class="prof-pane hidden" id="dev-pane-events">
                        <div class="dev-control-grid">
                            <div class="dev-card">
                                <h4>🎟️ Create Promo Code (ccode)</h4>
                                <div class="pshop-form-row">
                                    <input type="text" id="dev-code-name" class="win-input" placeholder="Code Name (e.g. ARIS2026)" />
                                    <input type="number" id="dev-code-max" class="win-input small" value="100" title="Max Uses (0=Infinite)" />
                                </div>
                                <input type="text" id="dev-code-rewards" class="win-input full-w" placeholder="coin:50000, crystal:50, luck_pot:10" />
                                <button class="win-btn primary full-w" id="btn-dev-create-code">Create / Update Code</button>
                                <div id="dev-codes-list" style="max-height:110px; overflow-y:auto; font-size:11px;"></div>
                            </div>

                            <div class="dev-card">
                                <h4>🌍 Global Server Events &amp; Market</h4>
                                <div id="dev-events-status" style="font-size:11px; color:var(--win-text-dim)"></div>
                                <button class="win-btn full-w" id="btn-dev-toggle-bshop">🛒 Force Spawn / Close Black Market</button>
                                <button class="win-btn full-w" id="btn-dev-refresh-lb">🔄 Force Refresh All Leaderboards</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            desktop.appendChild(winDiv);
            bindSingleWindowLifecycle(winDiv);
            bindDevWindowEvents(winDiv);
        }

        renderDevOverviewData(overviewRes);
    }

    function bindDevWindowEvents(winDiv) {
        winDiv.querySelectorAll('[data-dev-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                winDiv.querySelectorAll('[data-dev-tab]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const tab = btn.getAttribute('data-dev-tab');
                document.getElementById('dev-pane-users').classList.toggle('hidden', tab !== 'users');
                document.getElementById('dev-pane-economy').classList.toggle('hidden', tab !== 'economy');
                document.getElementById('dev-pane-events').classList.toggle('hidden', tab !== 'events');
            });
        });

        const setFb = (msg) => {
            const el = document.getElementById('dev-control-feedback');
            if (el) el.textContent = msg || '';
        };

        document.getElementById('btn-return-own-user').addEventListener('click', async () => {
            if (!authUserId) return;
            currentUserId = authUserId;
            const uidIn = document.getElementById('dev-target-uid');
            if (uidIn) uidIn.value = authUserId;
            const sbIn = document.getElementById('dev-sb-uid');
            if (sbIn) sbIn.value = authUserId;
            rollHistory = [];
            inspectedProfileOverride = null;
            const rollHistEl = document.getElementById('roll-history-list');
            if (rollHistEl) rollHistEl.innerHTML = '';
            await refreshPlayerState();
            await refreshDevControlOverview();
        });

        document.getElementById('btn-dev-exec-curr').addEventListener('click', async () => {
            const targetId = document.getElementById('dev-target-uid').value.trim() || currentUserId;
            const field = document.getElementById('dev-curr-field').value;
            const op = document.getElementById('dev-curr-op').value;
            const amount = document.getElementById('dev-curr-amount').value.trim();
            const isLuck = field.startsWith('perm_');
            const res = await apiPost('/api/dev/control', {
                action: isLuck ? 'luck' : 'currency',
                targetId,
                field,
                op,
                amount
            });
            setFb(res.message || res.error || (res.ok ? '✅ Done.' : '❌ Request failed.'));
            await refreshPlayerState();
            await refreshDevControlOverview();
        });

        document.getElementById('btn-dev-exec-grant').addEventListener('click', async () => {
            const targetId = document.getElementById('dev-target-uid').value.trim() || currentUserId;
            const action = document.getElementById('dev-grant-type').value;
            const idVal = document.getElementById('dev-grant-id').value.trim();
            const qty = Number(document.getElementById('dev-grant-qty').value || 1);
            const res = await apiPost('/api/dev/control', {
                action,
                targetId,
                itemId: idVal,
                titleId: idVal,
                achId: idVal,
                qty,
                rolls: qty
            });
            setFb(res.message || res.error || (res.ok ? '✅ Done.' : '❌ Request failed.'));
            await refreshPlayerState();
        });

        document.getElementById('btn-dev-reset-user').addEventListener('click', async () => {
            const targetId = document.getElementById('dev-target-uid').value.trim() || currentUserId;
            openConfirmModal(
                '⚠️ Reset Player',
                `Are you sure you want to completely RESET player <strong>${escapeHtml(targetId)}</strong>?<br>This will wipe inventory, equipped items, score, rolls, and currency!`,
                async () => {
                    const res = await apiPost('/api/dev/control', { action: 'reset_player', targetId });
                    setFb(res.message || res.error || (res.ok ? '✅ Done.' : '❌ Request failed.'));
                    await refreshPlayerState();
                    await refreshDevControlOverview();
                }
            );
        });

        document.getElementById('btn-dev-create-code').addEventListener('click', async () => {
            const codeName = document.getElementById('dev-code-name').value.trim();
            const maxUses = document.getElementById('dev-code-max').value;
            const rewardsText = document.getElementById('dev-code-rewards').value.trim();
            const res = await apiPost('/api/dev/control', { action: 'create_code', codeName, maxUses, rewardsText });
            setFb(res.message || res.error || (res.ok ? '✅ Done.' : '❌ Request failed.'));
            await refreshDevControlOverview();
        });

        document.getElementById('btn-dev-toggle-bshop').addEventListener('click', async () => {
            const res = await apiPost('/api/dev/control', { action: 'toggle_bshop', targetId: (document.getElementById('dev-target-uid')?.value.trim() || currentUserId), durationMin: 10 });
            setFb(res.message || res.error || (res.ok ? '✅ Done.' : '❌ Request failed.'));
            await refreshPlayerState();
            await refreshDevControlOverview();
        });

        document.getElementById('btn-dev-refresh-lb').addEventListener('click', async () => {
            const res = await apiPost('/api/dev/control', { action: 'refresh_lb' });
            setFb(res.message || res.error || (res.ok ? '✅ Done.' : '❌ Request failed.'));
        });

        document.querySelectorAll('.dev-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const amt = btn.getAttribute('data-preset');
                const op = btn.getAttribute('data-op');
                const amtIn = document.getElementById('dev-curr-amount');
                const opIn = document.getElementById('dev-curr-op');
                if (amtIn && amt !== null) amtIn.value = amt;
                if (opIn && op) opIn.value = op;
            });
        });

        const grantPicker = document.getElementById('dev-grant-picker');
        if (grantPicker) {
            grantPicker.addEventListener('change', () => {
                const sel = grantPicker.options[grantPicker.selectedIndex];
                if (!sel || !sel.value) return;
                const typeSelect = document.getElementById('dev-grant-type');
                const idInput = document.getElementById('dev-grant-id');
                if (typeSelect && sel.dataset.type) typeSelect.value = sel.dataset.type;
                if (idInput) idInput.value = sel.value;
            });
        }

        const userFilterIn = document.getElementById('dev-user-filter');
        if (userFilterIn) {
            userFilterIn.addEventListener('input', () => {
                renderDevUsersList(userFilterIn.value.trim().toLowerCase());
            });
        }
    }

    let lastDevOverview = null;

    function populateDevGrantPicker() {
        const picker = document.getElementById('dev-grant-picker');
        if (!picker) return;

        const catIds = lastDevOverview?.catalogIds;
        const hasDevCatalog = Boolean(catIds && catIds.potions && catIds.potions.length > 0);
        const hasShopCatalog = Object.keys(shopCatalog.potions || {}).length > 0;

        if (picker.dataset.catalogLoaded === 'full') return;
        if (!hasDevCatalog && !hasShopCatalog) return;

        picker.innerHTML = '<option value="">✨ Quick Pick: Select Potion, Module, Chip, Title, Achievement...</option>';

        const gPot = document.createElement('optgroup');
        gPot.label = '🧪 Potions';
        if (hasDevCatalog) {
            catIds.potions.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.dataset.type = 'give_item';
                opt.textContent = `[Potion] ${item.name || item.id} (${item.id})`;
                gPot.appendChild(opt);
            });
        } else {
            Object.entries(shopCatalog.potions || {}).forEach(([id, item]) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.dataset.type = 'give_item';
                opt.textContent = `[Potion] ${item.name || id} (${id})`;
                gPot.appendChild(opt);
            });
        }
        picker.appendChild(gPot);

        const gMod = document.createElement('optgroup');
        gMod.label = '⚙️ Modules';
        if (hasDevCatalog) {
            catIds.modules.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.dataset.type = 'give_item';
                opt.textContent = `[Module] ${item.name || item.id} (${item.id})`;
                gMod.appendChild(opt);
            });
        } else {
            Object.entries(shopCatalog.modules || {}).forEach(([id, item]) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.dataset.type = 'give_item';
                opt.textContent = `[Module] ${item.name || id} (${id})`;
                gMod.appendChild(opt);
            });
        }
        picker.appendChild(gMod);

        const gChip = document.createElement('optgroup');
        gChip.label = '💾 Chips';
        if (hasDevCatalog) {
            catIds.chips.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.dataset.type = 'give_item';
                opt.textContent = `[Chip] ${item.name || item.id} (${item.id})`;
                gChip.appendChild(opt);
            });
        } else {
            Object.entries(shopCatalog.chips || {}).forEach(([id, item]) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.dataset.type = 'give_item';
                opt.textContent = `[Chip] ${item.name || id} (${id})`;
                gChip.appendChild(opt);
            });
        }
        picker.appendChild(gChip);

        const titlesList = (hasDevCatalog && catIds.titles) || (playerData && Array.isArray(playerData.titles) ? playerData.titles : []);
        if (titlesList.length > 0) {
            const gTitle = document.createElement('optgroup');
            gTitle.label = '👑 Titles';
            titlesList.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.dataset.type = 'give_title';
                opt.textContent = `[Title] ${t.name || t.id} (${t.id})`;
                gTitle.appendChild(opt);
            });
            picker.appendChild(gTitle);
        }

        const achList = (hasDevCatalog && catIds.achievements) || (playerData && Array.isArray(playerData.allAchievements) ? playerData.allAchievements : []);
        if (achList.length > 0) {
            const gAch = document.createElement('optgroup');
            gAch.label = '🏆 Achievements';
            achList.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.dataset.type = 'give_achieve';
                opt.textContent = `[Achieve] ${a.name || a.id} (${a.id})`;
                gAch.appendChild(opt);
            });
            picker.appendChild(gAch);
        }

        if (hasDevCatalog) {
            picker.dataset.catalogLoaded = 'full';
        }
    }

    function renderDevUsersList(filterText = '') {
        const listEl = document.getElementById('users-list');
        if (!listEl || !lastDevOverview || !lastDevOverview.users) return;
        listEl.innerHTML = '';
        const filtered = lastDevOverview.users.filter(u => {
            if (!filterText) return true;
            return (u.username || '').toLowerCase().includes(filterText) || String(u.id || '').includes(filterText);
        });

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="empty-hint" style="padding:10px;">No users found matching filter.</div>';
            return;
        }

        filtered.forEach(u => {
            const row = document.createElement('div');
            row.className = 'user-row' + (u.id === currentUserId ? ' active-user' : '');
            row.innerHTML = `
                <div>
                    <strong>${escapeHtml(u.username || 'Player')}</strong>
                    <div style="font-size:10px; color:#888">${escapeHtml(String(u.id))}</div>
                </div>
                <div style="text-align:right; font-family:'JetBrains Mono', monospace; font-size:11px;">
                    <div>🎲 ${fmtNum(u.total_rolls)} rolls</div>
                    <div style="color:#fcff61">🪙 ${fmtNum(u.coins)}</div>
                </div>
            `;
            row.addEventListener('click', async () => {
                currentUserId = u.id;
                const uidIn = document.getElementById('dev-target-uid');
                if (uidIn) uidIn.value = u.id;
                const sbIn = document.getElementById('dev-sb-uid');
                if (sbIn) sbIn.value = u.id;
                rollHistory = [];
                inspectedProfileOverride = null;
                document.getElementById('roll-history-list').innerHTML = '';
                await refreshPlayerState();
                await refreshDevControlOverview();
            });
            listEl.appendChild(row);
        });
    }

    async function refreshDevControlOverview() {
        if (!isDevAccount) return;
        const res = await apiGet('/api/dev/overview');
        if (res && res.ok) {
            renderDevOverviewData(res);
        }
    }

    function renderDevOverviewData(overview) {
        lastDevOverview = overview;
        populateDevGrantPicker();
        const userFilterIn = document.getElementById('dev-user-filter');
        const filterVal = userFilterIn ? userFilterIn.value.trim().toLowerCase() : '';
        renderDevUsersList(filterVal);

        const codesList = document.getElementById('dev-codes-list');
        if (codesList && overview.codes) {
            codesList.innerHTML = overview.codes.length === 0
                ? '<div class="empty-hint">No promo codes in database.</div>'
                : '';
            overview.codes.forEach(c => {
                const div = document.createElement('div');
                div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:3px 0; border-bottom:1px solid var(--win-border);';
                div.innerHTML = `
                    <span><strong>${escapeHtml(c.code)}</strong> (${c.current_uses}/${c.max_uses || '∞'})</span>
                    <button class="win-btn small danger" data-del-code="${escapeHtml(c.code)}">Del</button>
                `;
                codesList.appendChild(div);
            });
            codesList.querySelectorAll('[data-del-code]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const codeName = btn.getAttribute('data-del-code');
                    openConfirmModal(
                        '🗑️ Delete Promo Code',
                        `Delete code <strong>${escapeHtml(codeName)}</strong> and all of its redemptions?`,
                        async () => {
                            const r = await apiPost('/api/dev/control', { action: 'delete_code', codeName });
                            showWinToast(r.message || r.error || 'Done.', r.ok ? 'info' : 'warning', 'Dev Control');
                            await refreshDevControlOverview();
                        }
                    );
                });
            });
        }

        const evStatus = document.getElementById('dev-events-status');
        if (evStatus) {
            evStatus.innerHTML = `
                BShop: <strong>${overview.blackMarket?.active ? '🟢 OPEN' : 'CLOSED'}</strong>
            `;
        }
    }

    async function completeAuthentication(token, userObj) {
        sessionToken = token;
        localStorage.setItem('aris_session_token', token);
        authUserId = userObj.id;
        currentUserId = userObj.id;
        isDevAccount = Boolean(userObj.isDev);
        rollHistory = [];
        inspectedProfileOverride = null;

        const lockEl = document.getElementById('lock-screen');
        if (lockEl) {
            lockEl.classList.add('unlocked');
            lockEl.style.display = 'none';
            lockEl.style.transform = '';
            lockEl.style.transition = '';
        }
        const loginEl = document.getElementById('login-screen');
        if (loginEl) {
            loginEl.classList.add('hidden');
            loginEl.style.display = 'none';
        }

        closeAllWindows();

        await refreshPlayerState();
        await mountDynamicDevGui();

        openWindow('win-roll');
    }

    async function handleLogout() {
        await apiPost('/api/auth/logout', {});
        sessionToken = '';
        authUserId = null;
        currentUserId = null;
        isDevAccount = false;
        playerData = null;
        autoRollActive = false;
        localStorage.removeItem('aris_session_token');

        unmountDynamicDevGui();
        closeAllWindows();
        const lockEl = document.getElementById('lock-screen');
        if (lockEl) {
            lockEl.classList.remove('unlocked');
            lockEl.style.display = '';
            lockEl.style.transform = '';
            lockEl.style.transition = '';
        }
        const loginEl = document.getElementById('login-screen');
        if (loginEl) {
            loginEl.classList.remove('hidden');
            loginEl.style.display = '';
        }
        const errEl = document.getElementById('login-error');
        if (errEl) errEl.classList.add('hidden');
        const sucEl = document.getElementById('login-success');
        if (sucEl) sucEl.classList.add('hidden');

        const loginOauthView = document.getElementById('login-oauth-view');
        const loginOtpView = document.getElementById('login-otp-view');
        const btnToggleSigninOptions = document.getElementById('btn-toggle-signin-options');
        const btnBackOauth = document.getElementById('btn-back-oauth');
        if (loginOauthView) loginOauthView.classList.remove('hidden');
        if (loginOtpView) loginOtpView.classList.add('hidden');
        if (btnToggleSigninOptions) btnToggleSigninOptions.classList.remove('hidden');
        if (btnBackOauth) btnBackOauth.classList.add('hidden');
    }

    function startSessionHeartbeatLoop() {
        let heartbeatTimer = null;

        const runCycle = async () => {
            if (!sessionToken || !authUserId) return;
            const isHidden = typeof document !== 'undefined' && document.hidden;
            
            try {
                await apiPost('/api/auth/heartbeat', {});
            } catch (e) {}

            if (!isHidden) {
                try {
                    await refreshPlayerState();
                } catch (e) {}
            }
        };

        const scheduleNext = () => {
            if (heartbeatTimer) clearTimeout(heartbeatTimer);
            const isHidden = typeof document !== 'undefined' && document.hidden;
            const delay = isHidden ? 20000 : 5000;
            heartbeatTimer = setTimeout(async () => {
                await runCycle();
                scheduleNext();
            }, delay);
        };

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    runCycle();
                    scheduleNext();
                }
            });
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => {
                autoRollActive = false;
            });
        }

        scheduleNext();
    }

    function bindActionListeners() {
        const showLoginError = (msg) => {
            const errEl = document.getElementById('login-error');
            const sucEl = document.getElementById('login-success');
            if (sucEl) sucEl.classList.add('hidden');
            errEl.textContent = msg;
            errEl.classList.remove('hidden');
        };

        const showLoginSuccess = (msg) => {
            const errEl = document.getElementById('login-error');
            const sucEl = document.getElementById('login-success');
            if (errEl) errEl.classList.add('hidden');
            if (sucEl) {
                sucEl.textContent = msg;
                sucEl.classList.remove('hidden');
            }
        };

        let pendingOtpUserId = null;
        let otpCooldownTimer = null;

        const startOtpCooldown = (sec) => {
            if (otpCooldownTimer) clearInterval(otpCooldownTimer);
            const btn = document.getElementById('btn-request-otp');
            if (!btn) return;
            const targetTime = Date.now() + sec * 1000;
            localStorage.setItem('aris_otp_cooldown_until', String(targetTime));
            btn.disabled = true;

            const update = () => {
                const rem = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
                if (rem <= 0) {
                    clearInterval(otpCooldownTimer);
                    otpCooldownTimer = null;
                    localStorage.removeItem('aris_otp_cooldown_until');
                    btn.disabled = false;
                    btn.textContent = '📩 Send code to Discord DM';
                } else {
                    btn.textContent = `⏳ Resend code in ${rem}s`;
                }
            };
            update();
            otpCooldownTimer = setInterval(update, 1000);
        };

        const savedCooldownUntil = localStorage.getItem('aris_otp_cooldown_until');
        if (savedCooldownUntil) {
            const remSec = Math.ceil((Number(savedCooldownUntil) - Date.now()) / 1000);
            if (remSec > 0) {
                startOtpCooldown(remSec);
            } else {
                localStorage.removeItem('aris_otp_cooldown_until');
            }
        }

        const handleRequestOtp = async () => {
            const inputEl = document.getElementById('login-otp-identifier');
            const identifier = inputEl ? inputEl.value.trim() : '';
            if (!identifier) {
                showLoginError('Please enter your Discord Username or Discord User ID first.');
                return;
            }
            const btn = document.getElementById('btn-request-otp');
            if (btn) btn.disabled = true;
            try {
                const res = await apiPost('/api/auth/request-otp', { identifier });
                if (res.ok && res.userId) {
                    pendingOtpUserId = res.userId;
                    showLoginSuccess(res.message || 'Verification code sent to your Discord DM!');
                    startOtpCooldown(res.cooldown || 60);
                    const codeInput = document.getElementById('login-otp-code');
                    if (codeInput) codeInput.focus();
                } else {
                    showLoginError(res.error || 'Could not send verification code.');
                    if (res.retryAfter) {
                        startOtpCooldown(res.retryAfter);
                    } else if (btn) {
                        btn.disabled = false;
                    }
                }
            } catch (err) {
                showLoginError('Failed to request verification code. Please check your network.');
                if (btn) btn.disabled = false;
            }
        };

        const handleVerifyOtp = async () => {
            const codeInput = document.getElementById('login-otp-code');
            const rawOtp = codeInput ? codeInput.value.trim() : '';
            const cleanOtp = rawOtp.replace(/\D/g, '');
            const identifier = document.getElementById('login-otp-identifier')?.value.trim() || '';
            const targetId = pendingOtpUserId || identifier;

            if (!cleanOtp || cleanOtp.length < 6) {
                showLoginError('Please enter the 6-digit verification code from your Discord DM.');
                return;
            }

            const btn = document.getElementById('btn-verify-otp');
            if (btn) btn.disabled = true;

            try {
                const res = await apiPost('/api/auth/verify-otp', { userId: targetId, otp: cleanOtp });
                if (res.ok && res.token && res.user) {
                    await completeAuthentication(res.token, res.user);
                } else {
                    showLoginError(res.error || 'Invalid or expired verification code.');
                }
            } finally {
                if (btn) btn.disabled = false;
            }
        };

        const btnReqOtp = document.getElementById('btn-request-otp');
        if (btnReqOtp) btnReqOtp.addEventListener('click', handleRequestOtp);

        const btnVerOtp = document.getElementById('btn-verify-otp');
        if (btnVerOtp) btnVerOtp.addEventListener('click', handleVerifyOtp);

        const otpIdInput = document.getElementById('login-otp-identifier');
        const otpCodeInput = document.getElementById('login-otp-code');

        if (otpIdInput) {
            otpIdInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (otpCodeInput && otpCodeInput.value.trim().length >= 6) {
                        handleVerifyOtp();
                    } else {
                        handleRequestOtp();
                    }
                }
            });
        }

        if (otpCodeInput) {
            otpCodeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleVerifyOtp();
            });
        }

        const btnToggleSigninOptions = document.getElementById('btn-toggle-signin-options');
        const btnBackOauth = document.getElementById('btn-back-oauth');
        const loginOauthView = document.getElementById('login-oauth-view');
        const loginOtpView = document.getElementById('login-otp-view');

        if (btnToggleSigninOptions && btnBackOauth && loginOauthView && loginOtpView) {
            btnToggleSigninOptions.addEventListener('click', () => {
                loginOauthView.classList.add('hidden');
                btnToggleSigninOptions.classList.add('hidden');
                loginOtpView.classList.remove('hidden');
                btnBackOauth.classList.remove('hidden');
                const otpInput = document.getElementById('login-otp-identifier');
                if (otpInput) otpInput.focus();
            });

            btnBackOauth.addEventListener('click', () => {
                loginOtpView.classList.add('hidden');
                btnBackOauth.classList.add('hidden');
                loginOauthView.classList.remove('hidden');
                btnToggleSigninOptions.classList.remove('hidden');
            });
        }

        const btnDiscordOauth = document.getElementById('btn-discord-oauth');
        if (btnDiscordOauth) {
            btnDiscordOauth.addEventListener('click', async () => {
                const redirectUri = (window.location.origin + '/').replace('://127.0.0.1:', '://localhost:');
                const res = await apiGet(`/api/auth/oauth-url?redirectUri=${encodeURIComponent(redirectUri)}`);
                if (res.ok && res.url) {
                    window.location.href = res.url;
                } else {
                    showLoginError(res.error || 'Discord OAuth2 URL could not be generated.');
                }
            });
        }

        const btnTopLogout = document.getElementById('btn-top-logout');
        if (btnTopLogout) {
            btnTopLogout.addEventListener('click', (e) => {
                e.stopPropagation();
                requestLogoutConfirmation();
            });
        }

        const btnInvLogout = document.getElementById('btn-inv-logout');
        if (btnInvLogout) {
            btnInvLogout.addEventListener('click', (e) => {
                e.stopPropagation();
                requestLogoutConfirmation();
            });
        }

        const btnSettingsLogout = document.getElementById('btn-settings-logout');
        if (btnSettingsLogout) {
            btnSettingsLogout.addEventListener('click', (e) => {
                e.stopPropagation();
                requestLogoutConfirmation();
            });
        }

        const shopSearchIn = document.getElementById('shop-search-input');
        if (shopSearchIn) {
            shopSearchIn.addEventListener('input', () => renderShopList());
        }
        const invPotSearchIn = document.getElementById('inv-pot-search');
        if (invPotSearchIn) {
            invPotSearchIn.addEventListener('input', () => renderOwnedPotionsTable(playerData?.ownedPotions || []));
        }
        const invHwSearchIn = document.getElementById('inv-hw-search');
        if (invHwSearchIn) {
            invHwSearchIn.addEventListener('input', () => renderOwnedHardwareTable(playerData?.ownedHardware || []));
        }
        const achSearchIn = document.getElementById('ach-search-input');
        if (achSearchIn) {
            achSearchIn.addEventListener('input', () => renderAchievementsTable(playerData?.allAchievements || []));
        }
        const titleSearchIn = document.getElementById('title-search-input');
        if (titleSearchIn) {
            titleSearchIn.addEventListener('input', () => renderTitlesTable(playerData?.titles || []));
        }

        document.getElementById('btn-roll-now').addEventListener('click', () => triggerRoll(false));
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                if (e.repeat) return;
                const activeTag = document.activeElement ? document.activeElement.tagName : '';
                if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA' || activeTag === 'BUTTON' || (document.activeElement && document.activeElement.isContentEditable)) {
                    return;
                }
                const rollWin = document.getElementById('win-roll');
                if (rollWin && rollWin.classList.contains('active-window') && !rollWin.classList.contains('hidden')) {
                    e.preventDefault();
                    triggerRoll(false);
                }
            }
        });

        document.getElementById('btn-auto-roll').addEventListener('click', () => {
            if (!playerData?.user?.has_auto_chip) {
                document.getElementById('roll-action-status').textContent = '🔒 Equip Auto-Roll Machine or use Automatic Potion first!';
                return;
            }
            autoRollActive = !autoRollActive;
            const btn = document.getElementById('btn-auto-roll');
            btn.classList.toggle('primary', autoRollActive);
            updateAllViews();
        });

        document.querySelectorAll('[data-shop-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                document.querySelectorAll('[data-shop-tab]').forEach(b => b.classList.remove('active'));
                tabBtn.classList.add('active');
                currentShopTab = tabBtn.getAttribute('data-shop-tab');
                selectedShopItemId = null;
                renderShopList();
            });
        });

        document.querySelectorAll('#win-settings .settings-nav-item[data-set-pane]').forEach(navBtn => {
            navBtn.addEventListener('click', () => {
                const targetPane = navBtn.getAttribute('data-set-pane');
                document.querySelectorAll('#win-settings .settings-nav-item[data-set-pane]').forEach(btn => {
                    btn.classList.toggle('active', btn === navBtn);
                });
                document.querySelectorAll('#win-settings .settings-content-pane').forEach(pane => {
                    pane.classList.toggle('hidden', pane.id !== `set-pane-${targetPane}`);
                });
            });
        });

        document.querySelectorAll('[data-taskmgr-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                document.querySelectorAll('[data-taskmgr-tab]').forEach(b => b.classList.remove('active'));
                tabBtn.classList.add('active');
                const tab = tabBtn.getAttribute('data-taskmgr-tab');
                const perfPane = document.getElementById('taskmgr-pane-perf');
                const procsPane = document.getElementById('taskmgr-pane-procs');
                const hwPane = document.getElementById('taskmgr-pane-hw');
                if (perfPane) perfPane.classList.toggle('hidden', tab !== 'perf');
                if (procsPane) procsPane.classList.toggle('hidden', tab !== 'procs');
                if (hwPane) hwPane.classList.toggle('hidden', tab !== 'hw');
                if (tab === 'perf') {
                    updateTaskMgrGraph();
                } else if (tab === 'hw') {
                    renderHardwareCounters();
                }
            });
        });

        const luckCanvas = document.getElementById('taskmgr-luck-canvas');
        if (luckCanvas) {
            luckCanvas.addEventListener('mousemove', (e) => {
                if (telemetryHistory.length === 0) return;
                const rect = luckCanvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const state = window.telemetryState || { windowSize: 250 };
                const displayedHistory = telemetryHistory.slice(-state.windowSize);
                const count = displayedHistory.length;
                if (count === 0) return;

                const parentW = luckCanvas.parentElement ? luckCanvas.parentElement.clientWidth : 380;
                const w = luckCanvas.width = Math.max(200, parentW);

                const fraction = Math.max(0, Math.min(1, mouseX / w));
                crosshairIndex = Math.min(count - 1, Math.round(fraction * (count - 1)));
                if (window.telemetryState) window.telemetryState.hoverIndex = crosshairIndex;
                renderTaskMgrCanvas();
                showTelemetryTooltip(e, mouseX, displayedHistory[crosshairIndex]);
            });

            luckCanvas.addEventListener('mouseleave', () => {
                crosshairIndex = null;
                if (window.telemetryState) window.telemetryState.hoverIndex = -1;
                const tooltipEl = document.getElementById('taskmgr-hud-tooltip');
                if (tooltipEl) tooltipEl.classList.add('hidden');
                renderTaskMgrCanvas();
            });
        }

        document.querySelectorAll('[data-inv-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                document.querySelectorAll('[data-inv-tab]').forEach(b => b.classList.remove('active'));
                tabBtn.classList.add('active');
                const tab = tabBtn.getAttribute('data-inv-tab');
                document.getElementById('inv-pane-rolls').classList.toggle('hidden', tab !== 'rolls');
                document.getElementById('inv-pane-potions').classList.toggle('hidden', tab !== 'potions');
                document.getElementById('inv-pane-hardware').classList.toggle('hidden', tab !== 'hardware');
            });
        });

        document.querySelectorAll('[data-prof-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                document.querySelectorAll('[data-prof-tab]').forEach(b => b.classList.remove('active'));
                tabBtn.classList.add('active');
                const tab = tabBtn.getAttribute('data-prof-tab');
                document.getElementById('prof-pane-stat').classList.toggle('hidden', tab !== 'stat');
                document.getElementById('prof-pane-achieve').classList.toggle('hidden', tab !== 'achieve');
                document.getElementById('prof-pane-titles').classList.toggle('hidden', tab !== 'titles');
            });
        });

        document.getElementById('btn-stat-lookup').addEventListener('click', async () => {
            const q = document.getElementById('stat-lookup-input').value.trim();
            if (!q) return;
            const res = await apiGet(`/api/stat/lookup?query=${encodeURIComponent(q)}&requesterId=${encodeURIComponent(currentUserId)}`);
            if (res.ok && res.profile) {
                inspectedProfileOverride = res.profile;
                renderProfilePane();
            } else {
                showWinToast(res.message || 'Player not found.', 'warning', 'Profile Lookup');
            }
        });
        document.getElementById('btn-stat-self').addEventListener('click', () => {
            inspectedProfileOverride = null;
            document.getElementById('stat-lookup-input').value = '';
            renderProfilePane();
        });

        document.querySelectorAll('[data-hub-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', () => {
                document.querySelectorAll('[data-hub-tab]').forEach(b => b.classList.remove('active'));
                tabBtn.classList.add('active');
                const tab = tabBtn.getAttribute('data-hub-tab');
                document.getElementById('hub-pane-daily').classList.toggle('hidden', tab !== 'daily');
                document.getElementById('hub-pane-pray').classList.toggle('hidden', tab !== 'pray');
                document.getElementById('hub-pane-quests').classList.toggle('hidden', tab !== 'quests');
                document.getElementById('hub-pane-code').classList.toggle('hidden', tab !== 'code');
                const guildPane = document.getElementById('hub-pane-guild');
                if (guildPane) guildPane.classList.toggle('hidden', tab !== 'guild');
            });
        });

        document.getElementById('btn-claim-daily').addEventListener('click', async () => {
            const res = await apiPost('/api/daily', { userId: currentUserId });
            const cleanMsg = (res.message || '').replace(/\*\*/g, '');
            document.getElementById('daily-feedback').textContent = cleanMsg;
            if (res.ok) {
                showWinToast(cleanMsg || 'Daily rewards claimed successfully!', 'info', 'Daily Reward');
            } else {
                showWinToast(cleanMsg || 'Daily reward unavailable.', 'error', 'Daily Reward');
            }
            await refreshPlayerState();
        });

        document.getElementById('btn-pray-now').addEventListener('click', async () => {
            const res = await apiPost('/api/pray', { userId: currentUserId });
            const cleanMsg = (res.message || '').replace(/\*\*/g, '');
            document.getElementById('pray-feedback').textContent = cleanMsg;
            if (res.ok) {
                showWinToast(cleanMsg || 'Offered prayer! Permanent Basic Luck increased.', 'info', 'Shrine of Probability');
            } else {
                showWinToast(cleanMsg || 'Shrine prayer unavailable.', 'error', 'Shrine Prayer');
            }
            await refreshPlayerState();
        });

        document.querySelectorAll('[data-qshop-buy]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const shopIndex = btn.getAttribute('data-qshop-buy');
                const label = btn.getAttribute('data-qshop-label') || btn.textContent.trim();
                openConfirmModal(
                    '🎫 Confirm Token Shop Purchase',
                    `Are you sure you want to purchase <strong>${label}</strong> using your Quest Tokens?`,
                    async () => {
                        const res = await apiPost('/api/quest/buy', { userId: currentUserId, shopIndex });
                        const cleanMsg = (res.message || '').replace(/\*\*/g, '');
                        document.getElementById('quest-feedback').textContent = cleanMsg;
                        if (res.ok) {
                            showWinToast(cleanMsg || 'Token exchange complete!', 'info', 'Token Shop');
                        } else {
                            showWinToast(cleanMsg || 'Exchange failed.', 'error', 'Token Shop');
                        }
                        await refreshPlayerState();
                    }
                );
            });
        });

        document.getElementById('btn-redeem-code').addEventListener('click', async () => {
            const code = document.getElementById('code-redeem-input').value.trim();
            if (!code) return;
            const res = await apiPost('/api/code', { userId: currentUserId, code });
            const cleanMsg = (res.message || '').replace(/\*\*/g, '');
            document.getElementById('code-feedback').textContent = cleanMsg;
            if (res.ok) {
                document.getElementById('code-redeem-input').value = '';
                showWinToast(cleanMsg || 'Code redeemed successfully!', 'info', 'Code Redemption');
            } else {
                showWinToast(cleanMsg || 'Invalid promotional code.', 'error', 'Code Redemption');
            }
            await refreshPlayerState();
        });

        document.getElementById('lb-type-select').addEventListener('change', (e) => {
            lbState.type = e.target.value;
            lbState.page = 1;
            loadLeaderboard();
        });
        document.getElementById('lb-period-select').addEventListener('change', (e) => {
            lbState.period = e.target.value;
            lbState.page = 1;
            loadLeaderboard();
        });
        document.getElementById('btn-lb-prev').addEventListener('click', () => {
            if (lbState.page > 1) { lbState.page -= 1; loadLeaderboard(); }
        });
        document.getElementById('btn-lb-next').addEventListener('click', () => {
            const btnNext = document.getElementById('btn-lb-next');
            if (btnNext && btnNext.disabled) return;
            if (lbState.page < 10) { lbState.page += 1; loadLeaderboard(); }
        });

        document.getElementById('btn-qty-10').addEventListener('click', () => {
            document.getElementById('shop-qty-input').value = '10';
            if (selectedShopItemId) {
                const item = getCatalogItem(selectedShopItemId);
                renderCraftChecklist(item, '10');
            }
        });
        document.getElementById('btn-qty-max').addEventListener('click', () => {
            const isBShop = currentShopTab === 'bshop';
            const maxNum = calculateMaxBuyQty(selectedShopItemId, isBShop);
            document.getElementById('shop-qty-input').value = String(maxNum);
            if (selectedShopItemId) {
                const item = getCatalogItem(selectedShopItemId);
                renderCraftChecklist(item, String(maxNum));
            }
        });

        const shopQtyInput = document.getElementById('shop-qty-input');
        if (shopQtyInput) {
            shopQtyInput.addEventListener('input', () => {
                if (selectedShopItemId) {
                    const item = getCatalogItem(selectedShopItemId);
                    renderCraftChecklist(item, shopQtyInput.value);
                }
            });
        }

        document.getElementById('btn-shop-buy').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!selectedShopItemId) return;
            const item = getCatalogItem(selectedShopItemId);
            if (!item) return;
            const rawQty = document.getElementById('shop-qty-input').value || '1';
            const isBShop = currentShopTab === 'bshop';
            const numQty = rawQty.toLowerCase() === 'max'
                ? calculateMaxBuyQty(selectedShopItemId, isBShop)
                : Math.max(1, parseInt(rawQty, 10) || 1);
            const actionLabel = item.craft ? 'Craft' : 'Purchase';
            const costText = formatItemCost(item, isBShop);

            openConfirmModal(
                `🛒 Confirm ${actionLabel}`,
                `Are you sure you want to <strong>${actionLabel.toLowerCase()} ${fmtNum(numQty)}x ${item.name || selectedShopItemId}</strong>?<br/><span style="color:var(--win-text-dim); font-size:12px;">Unit Cost / Recipe: ${costText}</span>`,
                async () => {
                    const res = await apiPost('/api/shop/buy', { userId: currentUserId, itemId: selectedShopItemId, qty: String(numQty), isBShop });
                    const fb = document.getElementById('shop-feedback');
                    const cleanMsg = (res.message || '').replace(/\*\*/g, '');
                    fb.textContent = cleanMsg;
                    if (!res.ok || cleanMsg.includes('Not enough') || cleanMsg.includes('❌')) {
                        showWinToast(cleanMsg, 'error', 'Purchase Failed');
                    } else {
                        showWinToast(cleanMsg || `Purchased ${numQty}x ${item.name || selectedShopItemId}!`, 'info', 'Purchase Successful');
                    }
                    await refreshPlayerState();
                }
            );
        });

        document.getElementById('btn-shop-use').addEventListener('click', async () => {
            if (!selectedShopItemId || selectedShopItemId === 'item_cc') return;
            const fb = document.getElementById('shop-feedback');

            if (shopCatalog.potions[selectedShopItemId]) {
                const qty = document.getElementById('shop-qty-input').value || '1';
                const res = await apiPost('/api/shop/use', { userId: currentUserId, itemId: selectedShopItemId, qty });
                const cleanMsg = (res.message || '').replace(/\*\*/g, '');
                fb.textContent = cleanMsg;
                if (!res.ok || cleanMsg.includes('❌')) {
                    showWinToast(cleanMsg, 'error', 'Potion Error');
                } else {
                    showWinToast(cleanMsg || 'Potion consumed successfully!', 'info', 'Potion Consumed');
                }
            } else {
                const type = shopCatalog.modules[selectedShopItemId] ? 'module' : 'chip';
                const res = await apiPost('/api/inventory/equip', { userId: currentUserId, itemId: selectedShopItemId, type });
                const cleanMsg = (res.message || (res.ok ? `Updated ${type} equipment!` : 'Error')).replace(/\*\*/g, '');
                fb.textContent = cleanMsg;
                if (!res.ok || cleanMsg.includes('❌')) {
                    showWinToast(cleanMsg, 'error', 'Equip Failed');
                } else {
                    showWinToast(cleanMsg, 'info', 'Hardware Equipped');
                }
            }
            await refreshPlayerState();
        });

        document.getElementById('btn-expand-slot').addEventListener('click', (e) => {
            e.stopPropagation();
            const costCrys = fmtNum(playerData?.expandCost || 1);
            openConfirmModal(
                '➕ Confirm Slot Expansion',
                `Expand your Roll Storage by <strong>+1 Slot</strong> for <strong>💎 ${costCrys} Crystals</strong>?`,
                async () => {
                    const res = await apiPost('/api/inventory/expand', { userId: currentUserId });
                    if (!res.ok) {
                        showWinToast(res.message || 'Not enough crystals.', 'error');
                    } else {
                        showWinToast(res.message || 'Storage expanded successfully!', 'info');
                    }
                    await refreshPlayerState();
                }
            );
        });

        document.getElementById('btn-sell-all').addEventListener('click', (e) => {
            e.stopPropagation();
            openConfirmModal(
                '🪙 Confirm Sell All Unlocked',
                'Are you sure you want to sell <strong>all unlocked numbers</strong> in your inventory for Coins?',
                async () => {
                    await apiPost('/api/inventory/sell-all', { userId: currentUserId });
                    await refreshPlayerState();
                }
            );
        });

        const SEARCHABLE_OS_ITEMS = [
            { icon: '🎲', name: 'Roll Engine', cmd: '>r, >roll', winId: 'win-roll', tab: null },
            { icon: '🛒', name: 'A.R.I.S Store', cmd: '>shop', winId: 'win-shop', tab: 'potions' },
            { icon: '🌑', name: 'Black Market', cmd: '>bshop', winId: 'win-shop', tab: 'bshop' },
            { icon: '🎒', name: 'Inventory & Storage', cmd: '>inv', winId: 'win-inventory', tab: null },
            { icon: '📊', name: 'Task Manager / Luck Status', cmd: '>status', winId: 'win-taskmgr', tab: null },
            { icon: '👤', name: 'Player Profile', cmd: '>stat', winId: 'win-profile', tab: 'stat' },
            { icon: '🏆', name: 'Achievements', cmd: '>achieve', winId: 'win-profile', tab: 'achieve' },
            { icon: '👑', name: 'Titles', cmd: '>title', winId: 'win-profile', tab: 'titles' },
            { icon: '🎁', name: 'Daily Supply Drop', cmd: '>daily', winId: 'win-hub', tab: 'daily' },
            { icon: '🙏', name: 'Shrine of Probability', cmd: '>pray', winId: 'win-hub', tab: 'pray' },
            { icon: '📜', name: 'Daily Quests', cmd: '>quest', winId: 'win-hub', tab: 'quests' },
            { icon: '🎟️', name: 'Redeem Code', cmd: '>code', winId: 'win-hub', tab: 'code' },
            { icon: '📘', name: 'Game Guide', cmd: '>guild', winId: 'win-hub', tab: 'guild' },
            { icon: '🏆', name: 'Global Leaderboard', cmd: '>lb', winId: 'win-leaderboard', tab: null },
            { icon: '💻', name: 'Command Prompt', cmd: '>terminal', winId: 'win-terminal', tab: null },
            { icon: '⚙️', name: 'System Settings', cmd: '>setting', winId: 'win-settings', tab: null }
        ];

        let searchFlyoutFiltered = [];
        let searchFlyoutIndex = -1;

        function renderSearchFlyout(query = '') {
            const flyout = document.getElementById('search-flyout');
            if (!flyout) return;
            const q = query.trim().toLowerCase();
            searchFlyoutFiltered = SEARCHABLE_OS_ITEMS.filter(it => {
                if (!q) return true;
                return it.name.toLowerCase().includes(q) || it.cmd.toLowerCase().includes(q);
            });

            if (searchFlyoutFiltered.length === 0) {
                flyout.innerHTML = `<div class="search-flyout-empty">No OS system commands found matching "${escapeHtml(query)}"</div>`;
                searchFlyoutIndex = -1;
                flyout.classList.remove('hidden');
                return;
            }

            searchFlyoutIndex = 0;
            flyout.innerHTML = searchFlyoutFiltered.map((it, idx) => `
                <div class="search-flyout-item ${idx === 0 ? 'highlighted' : ''}" data-idx="${idx}">
                    <div class="search-item-left">
                        <span>${it.icon}</span>
                        <span>${it.name}</span>
                    </div>
                    <span class="search-item-cmd">${it.cmd}</span>
                </div>
            `).join('');

            flyout.querySelectorAll('.search-flyout-item').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.idx, 10);
                    launchSearchItem(searchFlyoutFiltered[idx]);
                });
            });

            flyout.classList.remove('hidden');
        }

        function updateSearchFlyoutHighlight() {
            const flyout = document.getElementById('search-flyout');
            if (!flyout) return;
            const items = flyout.querySelectorAll('.search-flyout-item');
            items.forEach((it, idx) => {
                it.classList.toggle('highlighted', idx === searchFlyoutIndex);
                if (idx === searchFlyoutIndex) {
                    it.scrollIntoView({ block: 'nearest' });
                }
            });
        }

        function launchSearchItem(it) {
            const flyout = document.getElementById('search-flyout');
            const cortana = document.getElementById('cortana-input');
            if (flyout) flyout.classList.add('hidden');
            if (cortana) cortana.value = '';
            if (it) {
                openWindow(it.winId, it.tab || null);
            }
        }

        const termInput = document.getElementById('terminal-input');
        if (termInput) {
            termInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const v = termInput.value;
                    termInput.value = '';
                    if (v.trim()) {
                        terminalCmdHistory.push(v);
                        if (terminalCmdHistory.length > 50) terminalCmdHistory.shift();
                        terminalHistoryIndex = terminalCmdHistory.length;
                    }
                    runTerminalCommand(v);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (terminalCmdHistory.length === 0) return;
                    if (terminalHistoryIndex > 0) {
                        terminalHistoryIndex--;
                    } else {
                        terminalHistoryIndex = 0;
                    }
                    termInput.value = terminalCmdHistory[terminalHistoryIndex] || '';
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (terminalCmdHistory.length === 0) return;
                    if (terminalHistoryIndex < terminalCmdHistory.length - 1) {
                        terminalHistoryIndex++;
                        termInput.value = terminalCmdHistory[terminalHistoryIndex] || '';
                    } else {
                        terminalHistoryIndex = terminalCmdHistory.length;
                        termInput.value = '';
                    }
                }
            });
        }

        const cortana = document.getElementById('cortana-input');
        if (cortana) {
            cortana.addEventListener('focus', () => {
                renderSearchFlyout(cortana.value);
            });
            cortana.addEventListener('input', () => {
                renderSearchFlyout(cortana.value);
            });
            cortana.addEventListener('keydown', (e) => {
                const flyout = document.getElementById('search-flyout');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (searchFlyoutFiltered.length > 0) {
                        searchFlyoutIndex = (searchFlyoutIndex + 1) % searchFlyoutFiltered.length;
                        updateSearchFlyoutHighlight();
                    }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (searchFlyoutFiltered.length > 0) {
                        searchFlyoutIndex = (searchFlyoutIndex - 1 + searchFlyoutFiltered.length) % searchFlyoutFiltered.length;
                        updateSearchFlyoutHighlight();
                    }
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.repeat) return;
                    const v = cortana.value.trim();
                    if (searchFlyoutIndex >= 0 && searchFlyoutFiltered[searchFlyoutIndex]) {
                        launchSearchItem(searchFlyoutFiltered[searchFlyoutIndex]);
                    } else if (v) {
                        if (flyout) flyout.classList.add('hidden');
                        cortana.value = '';
                        runTerminalCommand(v);
                    }
                } else if (e.key === 'Escape') {
                    if (flyout) flyout.classList.add('hidden');
                }
            });
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#cortana-input') && !e.target.closest('#search-flyout')) {
                const flyout = document.getElementById('search-flyout');
                if (flyout) flyout.classList.add('hidden');
            }
        });

        const previewCardEl = document.getElementById('taskbar-preview-card');
        if (previewCardEl) {
            previewCardEl.addEventListener('mouseenter', () => {
                clearTimeout(previewHideTimeout);
            });
            previewCardEl.addEventListener('mouseleave', () => {
                previewHideTimeout = setTimeout(() => hideTaskbarPreview(), 200);
            });
        }

        const btnOpenAuth = document.getElementById('btn-open-auth');
        if (btnOpenAuth) {
            btnOpenAuth.addEventListener('click', () => {
                openWindow('win-settings');
            });
        }

        const themeSelect = document.getElementById('set-theme');
        if (themeSelect) {
            themeSelect.addEventListener('change', async (e) => {
                const newTheme = e.target.value === 'light' ? 'light' : 'dark';
                document.body.classList.toggle('light-theme', newTheme === 'light');
                localStorage.setItem('aris_theme', newTheme);
                if (currentUserId) {
                    await apiPost('/api/settings/save', {
                        userId: currentUserId,
                        settings: { theme: newTheme }
                    });
                }
            });
        }

        const hideWmCheck = document.getElementById('set-hide-watermark');
        if (hideWmCheck) {
            hideWmCheck.addEventListener('change', async (e) => {
                const isHidden = e.target.checked;
                const wmEl = document.getElementById('desktop-watermark');
                if (wmEl) wmEl.classList.toggle('hidden', isHidden);
                localStorage.setItem('aris_hide_watermark', isHidden ? '1' : '0');
                if (currentUserId) {
                    await apiPost('/api/settings/save', {
                        userId: currentUserId,
                        settings: { hide_watermark: isHidden }
                    });
                }
            });
        }

        const wpUploadBtn = document.getElementById('btn-wallpaper-upload');
        const wpResetBtn = document.getElementById('btn-wallpaper-reset');
        const wpFileInput = document.getElementById('set-wallpaper-file');
        const wpFitSelect = document.getElementById('set-wallpaper-fit');

        if (wpUploadBtn && wpFileInput) {
            wpUploadBtn.addEventListener('click', () => {
                wpFileInput.click();
            });

            wpFileInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                wpFileInput.value = '';
                if (!file) return;
                if (!file.type || !file.type.startsWith('image/')) {
                    showWinToast('Please select a valid image file (PNG, JPG, WebP, GIF).', 'warning', 'Wallpaper');
                    return;
                }
                if (file.size > 15 * 1024 * 1024) {
                    showWinToast('Image file is too large (max 15 MB).', 'warning', 'Wallpaper');
                    return;
                }

                const reader = new FileReader();
                reader.onload = async () => {
                    const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
                    if (!rawDataUrl) return;
                    const finalDataUrl = await compressWallpaperIfNeeded(rawDataUrl, file);
                    const fit = wpFitSelect ? wpFitSelect.value : 'cover';
                    applyCustomWallpaper(finalDataUrl, fit);
                    try {
                        localStorage.setItem('aris_custom_wallpaper', finalDataUrl);
                        localStorage.setItem('aris_custom_wallpaper_fit', fit);
                        showWinToast('Custom wallpaper applied and saved locally.', 'info', 'Personalization');
                    } catch {
                        showWinToast('Wallpaper applied for this session (image too large to save in browser storage).', 'warning', 'Personalization');
                    }
                };
                reader.onerror = () => {
                    showWinToast('Failed to read image file.', 'error', 'Wallpaper');
                };
                reader.readAsDataURL(file);
            });
        }

        if (wpFitSelect) {
            wpFitSelect.addEventListener('change', (e) => {
                const fit = e.target.value;
                localStorage.setItem('aris_custom_wallpaper_fit', fit);
                const savedWp = localStorage.getItem('aris_custom_wallpaper') || '';
                if (savedWp) applyCustomWallpaper(savedWp, fit);
            });
        }

        if (wpResetBtn) {
            wpResetBtn.addEventListener('click', () => {
                localStorage.removeItem('aris_custom_wallpaper');
                applyCustomWallpaper('', localStorage.getItem('aris_custom_wallpaper_fit') || 'cover');
                showWinToast('Desktop wallpaper reset to default.', 'info', 'Personalization');
            });
        }

        const startGuide = document.getElementById('start-item-guide');
        if (startGuide) {
            startGuide.addEventListener('click', () => {
                toggleStartMenu(false);
                openWindow('win-hub', 'guild');
            });
        }

        document.getElementById('btn-save-settings').addEventListener('click', async () => {
            const hideWmEl = document.getElementById('set-hide-watermark');
            const hideWmVal = hideWmEl ? hideWmEl.checked : false;
            localStorage.setItem('aris_hide_watermark', hideWmVal ? '1' : '0');

            const payload = {
                theme: document.getElementById('set-theme').value,
                hide_watermark: hideWmVal,
                auto_sell_threshold: document.getElementById('set-autosell-pos').value,
                auto_sell_threshold_neg: document.getElementById('set-autosell-neg').value,
                luck_toggle: document.getElementById('set-luck-toggle').checked,
                stat_privacy: document.getElementById('set-privacy').checked,
                bshop_ping: document.getElementById('set-bshop-ping').checked,
                hide_equip: document.getElementById('set-hide-equip').checked,
                custom_color: document.getElementById('set-custom-color').value
            };
            const res = await apiPost('/api/settings/save', { userId: currentUserId, settings: payload });
            const fb = document.getElementById('settings-feedback');
            if (fb) fb.textContent = res.message || 'Saved!';
            showWinToast(res.message || 'Settings saved successfully!', 'info', 'Settings');
            await refreshPlayerState();
        });
    }

    function handleViewportResize() {
        const warnEl = document.getElementById('screen-resolution-warning');
        const sizeEl = document.getElementById('res-current-size');
        const w = window.innerWidth;
        const h = window.innerHeight;

        if (w < 900 || h < 500) {
            if (warnEl) warnEl.classList.remove('hidden');
            if (sizeEl) sizeEl.textContent = `${w} × ${h}`;
        } else {
            if (warnEl) warnEl.classList.add('hidden');
            document.querySelectorAll('.window:not(.hidden)').forEach(win => {
                if (win.id === 'win-confirm-modal') return;
                const winW = win.offsetWidth || 500;
                const winH = win.offsetHeight || 400;
                let curLeft = parseInt(win.style.left, 10);
                let curTop = parseInt(win.style.top, 10);
                if (isNaN(curLeft)) curLeft = 100;
                if (isNaN(curTop)) curTop = 60;

                const maxLeft = Math.max(0, w - winW);
                const maxTop = Math.max(40, h - 45 - winH);

                if (curLeft > maxLeft) win.style.left = `${Math.max(0, maxLeft)}px`;
                if (curTop > maxTop) win.style.top = `${Math.max(40, maxTop)}px`;
            });
            renderTaskbar();
        }
    }

    function initLockScreen() {
        const lockScreen = document.getElementById('lock-screen');
        if (!lockScreen) return;

        let startY = 0;
        let deltaY = 0;
        let isDragging = false;
        let startTime = 0;

        const unlock = () => {
            if (lockScreen.classList.contains('unlocked')) return;
            lockScreen.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.35s ease-out';
            lockScreen.classList.add('unlocked');
            lockScreen.style.transform = '';
        };

        const onStart = (clientY) => {
            if (lockScreen.classList.contains('unlocked')) return;
            startY = clientY;
            deltaY = 0;
            isDragging = true;
            startTime = Date.now();
            lockScreen.style.transition = 'none';
        };

        const onMove = (clientY) => {
            if (!isDragging || lockScreen.classList.contains('unlocked')) return;
            const diff = startY - clientY;
            if (diff > 0) {
                deltaY = diff;
                const resistance = deltaY > 200 ? 200 + (deltaY - 200) * 0.7 : deltaY;
                lockScreen.style.transform = `translateY(-${resistance}px)`;
            } else {
                deltaY = 0;
                lockScreen.style.transform = 'translateY(0)';
            }
        };

        const onEnd = () => {
            if (!isDragging || lockScreen.classList.contains('unlocked')) return;
            isDragging = false;
            const elapsed = Date.now() - startTime;
            const velocity = deltaY / Math.max(1, elapsed);

            if (deltaY > 60 || velocity > 0.25) {
                unlock();
            } else {
                lockScreen.style.transition = 'transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.2)';
                lockScreen.style.transform = 'translateY(0)';
                setTimeout(() => {
                    if (!lockScreen.classList.contains('unlocked')) {
                        lockScreen.style.transition = '';
                        lockScreen.style.transform = '';
                    }
                }, 360);
            }
        };

        lockScreen.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            onStart(e.clientY);
        });
        window.addEventListener('mousemove', (e) => {
            if (isDragging) onMove(e.clientY);
        });
        window.addEventListener('mouseup', () => {
            if (isDragging) onEnd();
        });

        lockScreen.addEventListener('touchstart', (e) => {
            if (e.touches.length > 0) onStart(e.touches[0].clientY);
        }, { passive: true });
        window.addEventListener('touchmove', (e) => {
            if (isDragging && e.touches.length > 0) onMove(e.touches[0].clientY);
        }, { passive: true });
        window.addEventListener('touchend', () => {
            if (isDragging) onEnd();
        });

        lockScreen.addEventListener('click', (e) => {
            if (deltaY < 10) unlock();
        });

        window.addEventListener('keydown', (e) => {
            if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock'].includes(e.key)) return;
            if (lockScreen && !lockScreen.classList.contains('unlocked')) {
                unlock();
            }
        });

        window.addEventListener('wheel', (e) => {
            if (lockScreen && !lockScreen.classList.contains('unlocked')) {
                if (Math.abs(e.deltaY) > 5) unlock();
            }
        }, { passive: true });
    }

    function startClock() {
        const updateClock = () => {
            const now = new Date();
            const timeEl = document.getElementById('clock-time');
            if (timeEl) {
                timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
            const dateEl = document.getElementById('clock-date');
            if (dateEl) {
                dateEl.textContent = now.toLocaleDateString();
            }

            const lockClock = document.getElementById('lock-clock');
            const lockDate = document.getElementById('lock-date');
            if (lockClock) {
                const hours = String(now.getHours()).padStart(2, '0');
                const mins = String(now.getMinutes()).padStart(2, '0');
                lockClock.textContent = `${hours}:${mins}`;
            }
            if (lockDate) {
                lockDate.textContent = now.toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric'
                });
            }

            const lbCdEl = document.getElementById('lb-refresh-countdown');
            if (lbCdEl) {
                const nowSec = Math.floor(Date.now() / 1000);
                if (!lbNextRefreshUnix || lbNextRefreshUnix <= nowSec) {
                    lbNextRefreshUnix = nowSec + 300;
                    if (openWindows.has('win-leaderboard')) {
                        loadLeaderboard();
                    }
                }
                const remSec = Math.max(0, lbNextRefreshUnix - nowSec);
                lbCdEl.textContent = `⏳ Next refresh in: ${fmtDurationSec(remSec)}`;
            }
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    async function checkInitialAuth() {
        const redirectUri = (window.location.origin + '/').replace('://127.0.0.1:', '://localhost:');
        const uriDisplay = document.getElementById('oauth-redirect-uri-display');
        if (uriDisplay) uriDisplay.textContent = redirectUri;

        if (window.location.search && window.location.search.includes('magic_token=')) {
            const qParams = new URLSearchParams(window.location.search);
            const magicToken = qParams.get('magic_token');
            window.history.replaceState(null, '', window.location.pathname);
            if (magicToken) {
                const lockEl = document.getElementById('lock-screen');
                if (lockEl) {
                    lockEl.classList.add('unlocked');
                    lockEl.style.transform = '';
                    lockEl.style.transition = '';
                }
                const res = await apiPost('/api/auth/verify-otp', { magicToken });
                if (res.ok && res.token && res.user) {
                    await completeAuthentication(res.token, res.user);
                    return;
                } else {
                    const loginEl = document.getElementById('login-screen');
                    if (loginEl) loginEl.classList.remove('hidden');
                    const errEl = document.getElementById('login-error');
                    if (errEl) {
                        errEl.textContent = res.error || 'Magic Sign-In link expired or invalid. Please request a new code.';
                        errEl.classList.remove('hidden');
                    }
                }
            }
        }

        if (window.location.search && window.location.search.includes('code=')) {
            const qParams = new URLSearchParams(window.location.search);
            const code = qParams.get('code');
            window.history.replaceState(null, '', window.location.pathname);
            if (code) {
                const lockEl = document.getElementById('lock-screen');
                if (lockEl) {
                    lockEl.classList.add('unlocked');
                    lockEl.style.transform = '';
                    lockEl.style.transition = '';
                }
                const res = await apiPost('/api/auth/discord-code', { code, redirectUri });
                if (res.ok && res.token && res.user) {
                    await completeAuthentication(res.token, res.user);
                    return;
                } else {
                    const loginEl = document.getElementById('login-screen');
                    if (loginEl) loginEl.classList.remove('hidden');
                    const errEl = document.getElementById('login-error');
                    if (errEl) {
                        errEl.textContent = res.error || 'Discord sign-in failed.';
                        errEl.classList.remove('hidden');
                    }
                }
            }
        }

        if (window.location.hash && window.location.hash.includes('access_token=')) {
            const params = new URLSearchParams(window.location.hash.slice(1));
            const accessToken = params.get('access_token');
            window.history.replaceState(null, '', window.location.pathname);
            if (accessToken) {
                const res = await apiPost('/api/auth/discord-token', { accessToken });
                if (res.ok && res.token && res.user) {
                    await completeAuthentication(res.token, res.user);
                    return;
                }
            }
        }

        const meRes = await apiGet('/api/auth/me');
        if (meRes.ok && meRes.authenticated && meRes.user) {
            await completeAuthentication(sessionToken, meRes.user);
            return;
        }
        sessionToken = '';
        localStorage.removeItem('aris_session_token');

        const loginEl = document.getElementById('login-screen');
        if (loginEl) loginEl.classList.remove('hidden');
    }

    async function bootstrap() {
        window.ArisOS = {
            openWindow,
            closeWindow,
            minimizeWindow,
            showToast: showWinToast,
            escapeHtml,
            getShopCatalog: () => shopCatalog,
            getPlayerState: () => playerData
        };

        applyOsVisualPreferences({});
        initWindowControlsAndDragging();
        initLockScreen();
        bindActionListeners();
        startClock();
        startCooldownLoop();
        startSessionHeartbeatLoop();

        window.addEventListener('resize', handleViewportResize);
        handleViewportResize();

        await checkInitialAuth();

        apiGet('/api/shop/catalog').then(catRes => {
            if (catRes && catRes.ok) {
                shopCatalog = catRes.catalog;
                populateDevGrantPicker();
                if (playerData) updateAllViews();
                window.dispatchEvent(new CustomEvent('aris:catalog-loaded', { detail: shopCatalog }));
            }
        }).catch(() => {});
    }

    window.addEventListener('DOMContentLoaded', bootstrap);
})();
