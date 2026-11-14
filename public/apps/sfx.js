(() => {
    'use strict';

    const LS_SFX_ENABLED = 'aris_sfx_enabled';
    const LS_SFX_VOLUME = 'aris_sfx_volume';

    let audioCtx = null;
    let masterGain = null;
    let compressor = null;
    let shortNoiseBuffer = null;

    let enabled = localStorage.getItem(LS_SFX_ENABLED) !== '0';
    let volume = clampVol(parseFloat(localStorage.getItem(LS_SFX_VOLUME)));
    let unlocked = false;
    let lastPlayTimes = new Map();

    function clampVol(v) {
        if (!Number.isFinite(v)) return 0.45;
        return Math.max(0, Math.min(1, v));
    }

    function ensureContext() {
        if (!enabled) return null;
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            audioCtx = new Ctx();
            compressor = audioCtx.createDynamicsCompressor();
            compressor.threshold.value = -16;
            compressor.knee.value = 18;
            compressor.ratio.value = 6;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.12;

            masterGain = audioCtx.createGain();
            masterGain.gain.value = volume;

            compressor.connect(masterGain);
            masterGain.connect(audioCtx.destination);

            const len = Math.floor(audioCtx.sampleRate * 0.12);
            shortNoiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
            const ch = shortNoiseBuffer.getChannelData(0);
            let last = 0;
            for (let i = 0; i < len; i++) {
                const white = Math.random() * 2 - 1;
                last = (last + 0.18 * white) / 1.18;
                ch[i] = last * 1.4;
            }
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        return audioCtx;
    }

    function unlockAudio() {
        if (unlocked) return;
        unlocked = true;
        if (enabled) ensureContext();
    }

    function rateLimited(key, minGapMs = 35) {
        const now = performance.now();
        const prev = lastPlayTimes.get(key) || 0;
        if (now - prev < minGapMs) return true;
        lastPlayTimes.set(key, now);
        return false;
    }

    function playTone(ctx, opts) {
        const {
            freq = 440,
            endFreq = null,
            type = 'sine',
            delay = 0,
            attack = 0.004,
            decay = 0.08,
            gainPeak = 0.12,
            filterFreq = 3200,
            pan = 0
        } = opts || {};

        const t0 = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const g = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(Math.max(30, freq), t0);
        if (endFreq && endFreq !== freq) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t0 + decay);
        }

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(filterFreq, t0);
        filter.Q.value = 0.7;

        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(gainPeak, t0 + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

        osc.connect(filter);
        filter.connect(g);

        if (typeof ctx.createStereoPanner === 'function' && pan !== 0) {
            const panner = ctx.createStereoPanner();
            panner.pan.value = Math.max(-0.8, Math.min(0.8, pan));
            g.connect(panner);
            panner.connect(compressor);
        } else {
            g.connect(compressor);
        }

        osc.start(t0);
        osc.stop(t0 + attack + decay + 0.02);
    }

    function playNoiseBurst(ctx, opts) {
        if (!shortNoiseBuffer) return;
        const {
            delay = 0,
            duration = 0.025,
            filterType = 'bandpass',
            freq = 1600,
            endFreq = null,
            q = 1.2,
            gainPeak = 0.08,
            pan = 0
        } = opts || {};

        const t0 = ctx.currentTime + delay;
        const src = ctx.createBufferSource();
        src.buffer = shortNoiseBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = filterType;
        filter.frequency.setValueAtTime(freq, t0);
        if (endFreq && endFreq !== freq) {
            filter.frequency.exponentialRampToValueAtTime(Math.max(80, endFreq), t0 + duration);
        }
        filter.Q.value = q;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(gainPeak, t0 + Math.min(0.004, duration * 0.25));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

        src.connect(filter);
        filter.connect(g);

        if (typeof ctx.createStereoPanner === 'function' && pan !== 0) {
            const panner = ctx.createStereoPanner();
            panner.pan.value = Math.max(-0.8, Math.min(0.8, pan));
            g.connect(panner);
            panner.connect(compressor);
        } else {
            g.connect(compressor);
        }

        src.start(t0);
        src.stop(t0 + Math.min(0.11, duration + 0.01));
    }

    function playMarimbaNote(ctx, freq, delay = 0, gainPeak = 0.11, decay = 0.16, pan = 0) {
        playTone(ctx, { freq, type: 'sine', delay, attack: 0.004, decay, gainPeak, filterFreq: 3600, pan });
        playTone(ctx, { freq: freq * 2, type: 'sine', delay, attack: 0.003, decay: decay * 0.45, gainPeak: gainPeak * 0.22, filterFreq: 4200, pan });
    }

    const SOUNDS = {
        click(ctx) {
            if (rateLimited('click', 40)) return;
            playNoiseBurst(ctx, { duration: 0.012, filterType: 'bandpass', freq: 1850, q: 1.6, gainPeak: 0.055 });
            playTone(ctx, { freq: 520, endFreq: 260, type: 'sine', attack: 0.002, decay: 0.022, gainPeak: 0.045, filterFreq: 1800 });
        },

        nav(ctx) {
            if (rateLimited('nav', 45)) return;
            playNoiseBurst(ctx, { duration: 0.016, filterType: 'bandpass', freq: 1400, endFreq: 2100, q: 1.4, gainPeak: 0.045 });
            playTone(ctx, { freq: 620, endFreq: 760, type: 'sine', attack: 0.003, decay: 0.036, gainPeak: 0.048, filterFreq: 2400 });
        },

        open(ctx) {
            if (rateLimited('win-open', 70)) return;
            playNoiseBurst(ctx, { duration: 0.055, filterType: 'bandpass', freq: 700, endFreq: 1900, q: 0.9, gainPeak: 0.045 });
            playTone(ctx, { freq: 340, endFreq: 540, type: 'sine', attack: 0.008, decay: 0.095, gainPeak: 0.085, filterFreq: 2200 });
            playTone(ctx, { freq: 680, endFreq: 810, type: 'sine', delay: 0.028, attack: 0.006, decay: 0.09, gainPeak: 0.045, filterFreq: 2600 });
        },

        close(ctx) {
            if (rateLimited('win-close', 70)) return;
            playNoiseBurst(ctx, { duration: 0.045, filterType: 'lowpass', freq: 1100, endFreq: 380, q: 0.8, gainPeak: 0.04 });
            playTone(ctx, { freq: 440, endFreq: 230, type: 'sine', attack: 0.005, decay: 0.085, gainPeak: 0.075, filterFreq: 1500 });
        },

        minimize(ctx) {
            if (rateLimited('win-min', 70)) return;
            playNoiseBurst(ctx, { duration: 0.04, filterType: 'bandpass', freq: 1200, endFreq: 480, q: 1.0, gainPeak: 0.038 });
            playTone(ctx, { freq: 480, endFreq: 290, type: 'sine', attack: 0.004, decay: 0.075, gainPeak: 0.06, filterFreq: 1700 });
        },

        toast(ctx, opts) {
            if (rateLimited('toast', 120)) return;
            const kind = opts?.kind || 'info';
            if (kind === 'error') {
                playMarimbaNote(ctx, 330, 0, 0.085, 0.14);
                playMarimbaNote(ctx, 261.6, 0.08, 0.085, 0.22);
            } else if (kind === 'warning') {
                playMarimbaNote(ctx, 440, 0, 0.075, 0.12);
                playMarimbaNote(ctx, 392, 0.075, 0.075, 0.18);
            } else if (kind === 'success') {
                playMarimbaNote(ctx, 523.25, 0, 0.075, 0.14);
                playMarimbaNote(ctx, 659.25, 0.065, 0.075, 0.16);
                playMarimbaNote(ctx, 783.99, 0.13, 0.07, 0.22);
            } else {
                playMarimbaNote(ctx, 587.33, 0, 0.065, 0.13);
                playMarimbaNote(ctx, 783.99, 0.065, 0.06, 0.18);
            }
        },

        send(ctx) {
            if (rateLimited('send', 80)) return;
            playNoiseBurst(ctx, { duration: 0.028, filterType: 'bandpass', freq: 1300, endFreq: 2400, q: 1.1, gainPeak: 0.04 });
            playMarimbaNote(ctx, 523.25, 0, 0.07, 0.09);
            playMarimbaNote(ctx, 698.46, 0.045, 0.065, 0.12);
        },

        receive(ctx) {
            if (rateLimited('receive', 150)) return;
            playMarimbaNote(ctx, 659.25, 0, 0.075, 0.16);
            playMarimbaNote(ctx, 987.77, 0.07, 0.065, 0.24);
        },

        decrypt(ctx) {
            if (rateLimited('decrypt', 150)) return;
            const notes = [440, 554.37, 659.25, 880];
            notes.forEach((f, idx) => {
                playMarimbaNote(ctx, f, idx * 0.055, 0.07, 0.22, (idx - 1.5) * 0.18);
            });
        },

        win(ctx) {
            if (rateLimited('win', 250)) return;
            const chord = [523.25, 659.25, 783.99, 1046.5];
            chord.forEach((f, idx) => {
                playMarimbaNote(ctx, f, idx * 0.075, 0.085, 0.28, (idx - 1.5) * 0.15);
            });
        }
    };

    function play(name, opts) {
        if (!enabled) return;
        const fn = SOUNDS[name];
        if (!fn) return;
        const ctx = ensureContext();
        if (!ctx) return;
        try {
            fn(ctx, opts);
        } catch {
        }
    }

    function syncControlsUI() {
        const trayBtn = document.getElementById('tray-sfx-btn');
        if (trayBtn) {
            trayBtn.textContent = enabled ? '🔊' : '🔇';
            trayBtn.title = enabled ? 'UI Sounds: On (Click to Mute)' : 'UI Sounds: Muted (Click to Enable)';
            trayBtn.classList.toggle('is-muted', !enabled);
        }
        const setToggle = document.getElementById('set-sfx-enabled');
        if (setToggle) {
            setToggle.checked = enabled;
        }
        const setSlider = document.getElementById('set-sfx-volume');
        if (setSlider) {
            setSlider.value = String(Math.round(volume * 100));
        }
        const setLabel = document.getElementById('set-sfx-volume-label');
        if (setLabel) {
            setLabel.textContent = `${Math.round(volume * 100)}%`;
        }
    }

    function setEnabled(next) {
        enabled = !!next;
        localStorage.setItem(LS_SFX_ENABLED, enabled ? '1' : '0');
        if (enabled) {
            ensureContext();
            if (masterGain && audioCtx) {
                masterGain.gain.setTargetAtTime(volume, audioCtx.currentTime, 0.02);
            }
            play('nav');
        } else if (masterGain && audioCtx) {
            masterGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.02);
        }
        syncControlsUI();
    }

    function setVolume(v) {
        volume = clampVol(v);
        localStorage.setItem(LS_SFX_VOLUME, String(volume));
        if (masterGain && audioCtx && enabled) {
            masterGain.gain.setTargetAtTime(volume, audioCtx.currentTime, 0.02);
        }
        syncControlsUI();
    }

    function bindGlobalHooks() {
        window.addEventListener('pointerdown', unlockAudio, { passive: true });
        window.addEventListener('keydown', unlockAudio, { passive: true });

        if (window.ArisOS && typeof window.ArisOS.showToast === 'function' && !window.ArisOS.__sfxWrapped) {
            const origToast = window.ArisOS.showToast;
            window.ArisOS.showToast = function wrappedShowToast(message, type, title) {
                play('toast', { kind: type || 'info' });
                return origToast.apply(this, arguments);
            };
            window.ArisOS.__sfxWrapped = true;
        }

        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;

            if (target.closest('#tray-sfx-btn')) {
                setEnabled(!enabled);
                return;
            }

            if (target.closest('.nav-tab, .settings-nav-item')) {
                play('nav');
                return;
            }

            if (target.closest('.win-btn, .start-item, .taskbar-btn, .win-titlebar-controls button')) {
                if (target.closest('.btn-min, .btn-close, .win-ctrl-min, .win-ctrl-close')) return;
                play('click');
            }
        });

        const setToggle = document.getElementById('set-sfx-enabled');
        if (setToggle) {
            setToggle.addEventListener('change', (e) => {
                setEnabled(e.target.checked);
            });
        }

        const setSlider = document.getElementById('set-sfx-volume');
        if (setSlider) {
            setSlider.addEventListener('input', (e) => {
                const val = Number(e.target.value) / 100;
                setVolume(val);
            });
            setSlider.addEventListener('change', () => {
                if (enabled) play('nav');
            });
        }

        syncControlsUI();
    }

    window.ArisSFX = {
        play,
        isEnabled: () => enabled,
        setEnabled,
        getVolume: () => volume,
        setVolume,
        syncControlsUI
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindGlobalHooks);
    } else {
        bindGlobalHooks();
    }
})();
