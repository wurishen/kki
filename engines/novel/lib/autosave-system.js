export function niNovelNameFromFileName(fileName = '') {
    return String(fileName || '')
        .trim()
        .replace(/\.[^.]+$/u, '')
        .trim() || '未命名小说';
}

export function niFindCurrentNovelIndex(library = [], novelKey = '') {
    if (!novelKey) return -1;
    return (Array.isArray(library) ? library : []).findIndex(snap => snap?.data?._novelKey === novelKey);
}

export function createAutosaveController({
    state,
    getSettings,
    saveSettingsDebounced,
    saveNovelSnapshot,
    updateNovelSnapshot,
    renderNovelLibrary = () => {},
    delay = 1200,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = timerId => clearTimeout(timerId),
    logger = console,
} = {}) {
    let timer = null;
    let saving = false;
    let rerunRequested = false;
    let rerunNovelKey = '';

    function isEnabled() {
        return getSettings()?.autoSaveEnabled === true;
    }

    function setSourceFileName(fileName = '') {
        const cfg = getSettings();
        if (!cfg) return;
        cfg._autoSaveSourceName = niNovelNameFromFileName(fileName);
        saveSettingsDebounced();
    }

    async function saveNow() {
        if (timer) {
            clearTimer(timer);
            timer = null;
        }
        if (!isEnabled()) {
            rerunRequested = false;
            return false;
        }
        if (saving) {
            rerunRequested = true;
            rerunNovelKey = String(state?.novelKey || '');
            return false;
        }

        const cfg = getSettings() || {};
        const idx = niFindCurrentNovelIndex(cfg.novelLibrary, state?.novelKey);
        if (idx < 0 && !state?.fileLoaded) return false;

        saving = true;
        try {
            let saved;
            if (idx >= 0) {
                saved = await updateNovelSnapshot(idx, {
                    confirmUpdate: false,
                    notify: false,
                    throwOnError: true,
                    scheduleAutosave: false,
                });
            } else {
                saved = await saveNovelSnapshot(cfg._autoSaveSourceName || '未命名小说', {
                    notifyErrors: false,
                    throwOnError: true,
                    scheduleAutosave: false,
                });
            }
            if (saved === false) return false;
            renderNovelLibrary();
            return true;
        } catch (e) {
            logger.warn('[NI] 自动保存失败:', e);
            return false;
        } finally {
            saving = false;
            if (rerunRequested) {
                const expectedNovelKey = rerunNovelKey;
                rerunRequested = false;
                rerunNovelKey = '';
                if (isEnabled() && String(state?.novelKey || '') === expectedNovelKey) void saveNow();
            }
        }
    }

    function schedule({ immediate = false } = {}) {
        if (!isEnabled()) return;
        if (saving) {
            rerunRequested = true;
            rerunNovelKey = String(state?.novelKey || '');
            return;
        }
        if (timer) clearTimer(timer);
        if (immediate) {
            void saveNow();
            return;
        }
        const scheduledNovelKey = String(state?.novelKey || '');
        timer = setTimer(() => {
            timer = null;
            if (String(state?.novelKey || '') !== scheduledNovelKey) return;
            void saveNow();
        }, delay);
    }

    function setEnabled(enabled) {
        const cfg = getSettings();
        if (!cfg) return;
        cfg.autoSaveEnabled = !!enabled;
        saveSettingsDebounced();
        if (enabled) schedule({ immediate: true });
        else {
            rerunRequested = false;
            rerunNovelKey = '';
            if (timer) {
                clearTimer(timer);
                timer = null;
            }
        }
    }

    return { isEnabled, setEnabled, setSourceFileName, schedule, saveNow };
}
